/**
 * Costo del producto: promedio ponderado al recibir mercancía, y costo congelado
 * en la línea de venta (para que editar el costo no reescriba el CMV histórico).
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
  Promise.resolve(fn(req, res, reject)).catch(reject)
})

const costOf = async (id) =>
  Number((await prisma.product.findUnique({ where: { id }, select: { cost: true } })).cost)

async function main() {
  const [stockStatus, role, payMethod] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
    prisma.paymentMethod.upsert({ where: { name: 'Efectivo' }, update: {}, create: { name: 'Efectivo' } }),
  ])
  await prisma.saleStatus.upsert({ where: { name: 'Completada' }, update: {}, create: { name: 'Completada' } })
  for (const n of ['Sin Stock', 'Stock Bajo']) {
    await prisma.alertType.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Crítica', 'Alta', 'Media', 'Baja']) {
    await prisma.alertPriority.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  await prisma.status.upsert({ where: { name: 'Activa' }, update: {}, create: { name: 'Activa' } })
  await prisma.status.upsert({ where: { name: 'Resuelta' }, update: {}, create: { name: 'Resuelta' } })

  const products = require('../src/modules/inventory/products.controller')
  const sales = require('../src/modules/sales/controller')

  const co = await prisma.company.create({ data: { name: 'Costos SA', code: `CO${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  await prisma.cashRegister.create({
    data: { branch_id: suc.id, name: 'Caja 1', code: 'C1', is_default: true },
  })
  const user = await prisma.user.create({
    data: { name: 'Admin', email: `k${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })
  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 200, cost: 0, stock: 0, min_stock: 0,
    },
  })

  const ingresar = (items) => callController(products.registerIncomingMerchandise, {
    body: { supplier_id: sup.id, items },
    companyId: co.id, branchId: suc.id, user: { sub: user.id }, query: {},
  })

  console.log('\n== Primer ingreso: 10 a Q60 ==')
  let r = await ingresar([{ product_id: ron.id, quantity: 10, unit_cost: 60 }])
  assert(r.status === 200 || r.status === 201, `el ingreso responde ok (${r.status}) ${JSON.stringify(r.body).slice(0, 200)}`)
  assert(await costOf(ron.id) === 60, 'sin stock previo, el costo es el de la factura: 60')

  console.log('\n== Segundo ingreso: 10 a Q100 ==')
  await ingresar([{ product_id: ron.id, quantity: 10, unit_cost: 100 }])
  assert(await costOf(ron.id) === 80, '(10*60 + 10*100)/20 = 80, no 100 ni 60')

  console.log('\n== Un ingreso con el mismo producto en dos líneas ==')
  // Si la segunda línea promediara contra la fila vieja de la base (stock 20,
  // costo 80) daría 93.33. Contra el resultado de la primera línea da 80.
  await ingresar([
    { product_id: ron.id, quantity: 10, unit_cost: 40 },
    { product_id: ron.id, quantity: 10, unit_cost: 120 },
  ])
  const tras3 = await costOf(ron.id)
  assert(tras3 === 80, `la segunda línea promedia contra la primera: 80 — quedó en ${tras3}`)
  const stock = await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: ron.id, branch_id: suc.id } },
  })
  assert(stock.stock === 40, 'y entraron las 40 unidades')

  console.log('\n== El costo se congela en la venta ==')
  const venta = await callController(sales.create, {
    body: {
      items: [{ product_id: ron.id, qty: 2, price: 200 }],
      customer: 'Cliente', is_final_consumer: true,
      payment_method_id: payMethod.id, amount_received: 400, change: 0,
    },
    companyId: co.id, branchId: suc.id,
    user: { sub: user.id, role: { name: 'Admin' } }, query: {},
  })
  assert(venta.status === 200 || venta.status === 201,
    `la venta responde ok (${venta.status}) ${JSON.stringify(venta.body).slice(0, 200)}`)

  const linea = await prisma.saleItem.findFirst({ where: { sale_id: venta.body.id } })
  assert(Number(linea.unit_cost) === 80, `la línea guarda el costo del momento: 80 — guardó ${linea.unit_cost}`)

  // Alguien corrige el costo del producto meses después.
  await prisma.product.update({ where: { id: ron.id }, data: { cost: 999 } })
  const releida = await prisma.saleItem.findFirst({ where: { sale_id: venta.body.id } })
  assert(Number(releida.unit_cost) === 80, 'y editar el costo del producto no toca el CMV de la venta ya hecha')

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
