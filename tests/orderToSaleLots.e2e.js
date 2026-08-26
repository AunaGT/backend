/**
 * Reporte de QA: Cotización -> Pedido -> Venta dejaba "Existencia física" y
 * "Con lote" desincronizados (Sin lote quedaba negativo). convertToSale
 * descontaba stock físico pero nunca corría consumeLotsFEFO, a diferencia de
 * una venta directa. Ver src/controllers/orders.controller.js exports.convertToSale.
 *
 * Uso: contra un Postgres desechable ya migrado.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) { console.error('FALLO:', msg); process.exitCode = 1; throw new Error(msg) }
  console.log('  ok:', msg)
}

const callController = (fn, req) => new Promise((resolve, reject) => {
  let status = 200
  const res = { status(code) { status = code; return res }, json(body) { resolve({ status, body }) } }
  Promise.resolve(fn(req, res, (e) => reject(e))).catch(reject)
})

async function main() {
  const [stockStatus, role, payMethod] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
    prisma.paymentMethod.upsert({ where: { name: 'Efectivo' }, update: {}, create: { name: 'Efectivo' } }),
  ])
  for (const n of ['Completada', 'Cancelada']) {
    await prisma.saleStatus.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }

  const { restoreStockMap } = require('../src/services/bomStock')
  const orders = require('../src/controllers/orders.controller')

  const co = await prisma.company.create({ data: { name: 'Lotes SA', code: `LT${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const caja = await prisma.cashRegister.create({
    data: { branch_id: suc.id, name: 'Caja 1', code: 'C1', is_default: true },
  })
  const user = await prisma.user.create({
    data: { name: 'Admin', email: `h${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })
  const cat = await prisma.productCategory.create({ data: { name: 'Bebidas', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const agua = await prisma.product.create({
    data: {
      name: 'Agua', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 10, cost: 4, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[agua.id, 2]]), suc.id, { reason: 'PURCHASE' }))
  await prisma.productLot.create({
    data: {
      product_id: agua.id, branch_id: suc.id, lot_code: 'L-TEST-0001',
      qty_received: 2, qty_remaining: 2, unit_cost: 4,
    },
  })

  await prisma.cashRegisterSession.create({
    data: { cash_register_id: caja.id, opened_by_id: user.id, opening_float: 0, status: 'OPEN' },
  })

  const req = (body, extra = {}) => ({
    body, companyId: co.id, branchId: suc.id, query: {},
    user: { sub: user.id, role: { name: 'Admin' } },
    get: () => undefined,
    ...extra,
  })

  console.log('\n== Cotización -> Pedido -> Venta reconcilia lotes ==')
  const creado = await callController(orders.create, req({
    items: [{ product_id: agua.id, qty: 1 }],
    customer: 'Cliente', is_final_consumer: true,
  }))
  assert(creado.status === 201, `el pedido se crea (${creado.status}) ${JSON.stringify(creado.body).slice(0, 200)}`)

  const confirmado = await callController(orders.confirm, req({}, { params: { id: creado.body.id } }))
  assert(confirmado.status === 200, `el pedido se confirma (${confirmado.status}) ${JSON.stringify(confirmado.body).slice(0, 200)}`)

  const vendido = await callController(orders.convertToSale, req({
    payment_method_id: payMethod.id, amount_received: 10, change: 0,
  }, { params: { id: creado.body.id } }))
  assert(vendido.status === 201, `el pedido se convierte en venta (${vendido.status}) ${JSON.stringify(vendido.body).slice(0, 200)}`)

  const stockRows = await prisma.productStockLocation.findMany({ where: { product_id: agua.id } })
  const physical = stockRows.reduce((s, r) => s + Number(r.stock || 0), 0)
  const lotRows = await prisma.productLot.findMany({ where: { product_id: agua.id, qty_remaining: { gt: 0 } } })
  const lotted = lotRows.reduce((s, l) => s + Number(l.qty_remaining || 0), 0)

  assert(physical === 1, `existencia física baja a 1 — quedó en ${physical}`)
  assert(lotted === 1, `con lote también baja a 1 — quedó en ${lotted}`)
  assert(physical === lotted, `física y lote quedan cuadradas — física ${physical}, lote ${lotted}`)

  console.log('\nTODO OK')
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
