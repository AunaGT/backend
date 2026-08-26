/**
 * El motor de posteo tiene que poder correr las veces que sea sin duplicar
 * asientos ya contabilizados. Mezcla venta, compra pagada (asiento de compra +
 * pago sintético del flujo viejo) y ajuste de inventario, corre el posteo dos
 * veces sin operaciones nuevas entre medio, y confirma que la segunda no
 * agregue nada.
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

const CUENTAS = [
  ['cash', '1101', 'Caja', 'ASSET'], ['bank', '1102', 'Bancos', 'ASSET'],
  ['receivables', '1103', 'Clientes', 'ASSET'], ['ivaCredit', '1104', 'IVA credito', 'ASSET'],
  ['inventory', '1105', 'Inventario', 'ASSET'], ['payables', '2101', 'Proveedores', 'LIABILITY'],
  ['ivaDebit', '2102', 'IVA debito', 'LIABILITY'], ['pequenoTax', '2103', 'Impuesto pequeno', 'LIABILITY'],
  ['retainedEarnings', '3201', 'Utilidades acumuladas', 'EQUITY'],
  ['currentEarnings', '3202', 'Utilidad del ejercicio', 'EQUITY'],
  ['sales', '4101', 'Ventas', 'INCOME'], ['salesReturns', '4102', 'Devoluciones', 'INCOME'],
  ['cogs', '5101', 'Costo de ventas', 'COST'], ['pequenoTaxExpense', '6105', 'Impuesto pequeno gasto', 'EXPENSE'],
]

async function main() {
  const [stockStatus, role] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
  ])
  await prisma.saleStatus.upsert({ where: { name: 'Completada' }, update: {}, create: { name: 'Completada' } })

  const { restoreStockMap, deductStockMap } = require('../src/services/bomStock')
  const { postPendingOperations } = require('../src/services/accounting/postingEngine')
  const stockMoves = require('../src/controllers/stockMoves.controller')

  const co = await prisma.company.create({ data: { name: 'Idempotencia SA', code: `ID${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const user = await prisma.user.create({
    data: { name: 'Contador', email: `a${Date.now()}@x.com`, password: 'h', role_id: role.id, default_branch_id: suc.id },
  })

  const codigos = {}
  for (const [key, code, name, type] of CUENTAS) {
    await prisma.account.create({ data: { company_id: co.id, code, name, type } })
    codigos[key] = code
  }
  await prisma.systemSetting.create({
    data: { company_id: co.id, key: 'accounting.defaultAccounts', value: JSON.stringify(codigos) },
  })
  // Pequeño contribuyente: sin desglose de IVA, la aritmética no depende de la tasa.
  await prisma.systemSetting.create({ data: { company_id: co.id, key: 'vat_affiliation', value: 'PEQUENO' } })

  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Proveedor', contact: 'c', company_id: co.id, party_type: 'SUPPLIER' } })
  const pm = await prisma.paymentMethod.upsert({ where: { name: 'Efectivo' }, update: {}, create: { name: 'Efectivo' } })

  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 25, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 50]]), suc.id, { reason: 'PURCHASE' }))
  const ubic = await prisma.stockLocation.findFirst({ where: { warehouse: { branch_id: suc.id } } })

  console.log('\n== Preparar: venta + compra pagada + ajuste ==')
  const saleStatus = await prisma.saleStatus.findFirst({ where: { name: 'Completada' } })
  await prisma.$transaction(async (tx) => {
    await deductStockMap(tx, new Map([[ron.id, 2]]), suc.id, { reason: 'SALE' })
    const sale = await tx.sale.create({
      data: {
        branch_id: suc.id, customer: 'Cliente', payment_method_id: pm.id,
        reference: `V-CTR-${Date.now() % 100000}`, date: new Date(), sold_at: new Date(),
        items: 2, subtotal: 200, total: 200, adjusted_total: 200, total_returned: 0,
        status_id: saleStatus.id, created_by: user.id,
      },
    })
    await tx.saleItem.create({ data: { sale_id: sale.id, product_id: ron.id, price: 100, unit_cost: 25, qty: 2 } })
  })

  const im = await prisma.incomingMerchandise.create({
    data: {
      branch_id: suc.id, supplier_id: sup.id, registered_by: user.id, date: new Date(),
      source: 'PURCHASE', payment_status: 'PAID', paid_at: new Date(),
    },
  })
  await prisma.incomingMerchandiseItem.create({
    data: { incoming_merchandise_id: im.id, product_id: ron.id, quantity: 10, unit_cost: 25 },
  })

  await callController(stockMoves.createAdjustment, {
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
    body: { location_id: ubic.id, lines: [{ product_id: ron.id, qty: -1 }], notes: 'merma' },
  })

  console.log('\n== Primer posteo: contabiliza todo ==')
  const r1 = await postPendingOperations(prisma, user.id, co.id)
  assert(r1.skipped.length === 0, `nada se omite — omitidos: ${JSON.stringify(r1.skipped)}`)
  // Venta + compra + pago sintético de la compra (PAID sin abonos) + ajuste = 4.
  assert(r1.posted === 4, `contabiliza los 4 (venta, compra, pago sintético, ajuste) — contabilizó ${r1.posted}`)
  const count1 = await prisma.journalEntry.count({ where: { company_id: co.id } })
  assert(count1 === 4, `4 asientos en el diario — hay ${count1}`)

  console.log('\n== Segundo posteo: nada nuevo, no debe agregar nada ==')
  const r2 = await postPendingOperations(prisma, user.id, co.id)
  assert(r2.posted === 0, `no contabiliza nada de nuevo — contabilizó ${r2.posted}`)
  const count2 = await prisma.journalEntry.count({ where: { company_id: co.id } })
  assert(count2 === 4, `siguen siendo 4 — hay ${count2} (se duplicó si es más)`)

  console.log('\n== Tercer posteo, por si acaso ==')
  await postPendingOperations(prisma, user.id, co.id)
  const count3 = await prisma.journalEntry.count({ where: { company_id: co.id } })
  assert(count3 === 4, `siguen siendo 4 tras un tercer posteo — hay ${count3}`)

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
