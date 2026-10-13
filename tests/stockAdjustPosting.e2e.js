/**
 * Los ajustes de inventario llegan a la contabilidad: merma contra costo de
 * ventas, sobrante a favor, y la cuenta de Inventario deja de separarse de la
 * valuación física.
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

// Las 14 cuentas que exige el motor, con los códigos del seed.
const CUENTAS = [
  ['cash', '1101', 'Caja', 'ASSET'], ['bank', '1102', 'Bancos', 'ASSET'],
  ['receivables', '1103', 'Clientes', 'ASSET'], ['ivaCredit', '1104', 'IVA crédito', 'ASSET'],
  ['inventory', '1105', 'Inventario', 'ASSET'], ['payables', '2101', 'Proveedores', 'LIABILITY'],
  ['ivaDebit', '2102', 'IVA débito', 'LIABILITY'], ['pequenoTax', '2103', 'Impuesto pequeño', 'LIABILITY'],
  ['retainedEarnings', '3201', 'Utilidades acumuladas', 'EQUITY'],
  ['currentEarnings', '3202', 'Utilidad del ejercicio', 'EQUITY'],
  ['sales', '4101', 'Ventas', 'INCOME'], ['salesReturns', '4102', 'Devoluciones', 'INCOME'],
  ['cogs', '5101', 'Costo de ventas', 'COST'], ['pequenoTaxExpense', '6105', 'Impuesto pequeño gasto', 'EXPENSE'],
]

async function main() {
  const [stockStatus, role] = await Promise.all([
    prisma.stockStatus.upsert({ where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' } }),
    prisma.role.upsert({ where: { name: 'Admin' }, update: {}, create: { name: 'Admin' } }),
  ])
  for (const n of ['Sin Stock', 'Stock Bajo']) {
    await prisma.alertType.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Crítica', 'Alta', 'Media', 'Baja']) {
    await prisma.alertPriority.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }
  for (const n of ['Activa', 'Resuelta']) {
    await prisma.status.upsert({ where: { name: n }, update: {}, create: { name: n } })
  }

  const { restoreStockMap } = require('../src/services/bomStock')
  const { postPendingOperations } = require('../src/services/accounting/postingEngine')
  const stockMoves = require('../src/modules/inventory/stock.controller')

  const co = await prisma.company.create({ data: { name: 'Ajustes SA', code: `AJ${Date.now() % 100000}` } })
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
  // Régimen pequeño: sin desglose de IVA, así el costo del ajuste es el costo
  // llano y la aritmética de la prueba no depende de la tasa.
  await prisma.systemSetting.create({
    data: { company_id: co.id, key: 'vat_affiliation', value: 'PEQUENO' },
  })

  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const ron = await prisma.product.create({
    data: {
      name: 'Ron', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 25, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[ron.id, 20]]), suc.id, { reason: 'PURCHASE' }))
  const ubic = await prisma.stockLocation.findFirst({ where: { warehouse: { branch_id: suc.id } } })

  const cuentaId = async (code) =>
    (await prisma.account.findFirst({ where: { company_id: co.id, code }, select: { id: true } })).id
  const inventarioId = await cuentaId('1105')
  const costoId = await cuentaId('5101')

  const asientosDeAjuste = () => prisma.journalEntry.findMany({
    where: { company_id: co.id, source_type: 'STOCK_ADJUSTMENT' },
    include: { lines: true },
    orderBy: { entry_number: 'asc' },
  })

  console.log('\n== 1. Merma: se dan de baja 3 unidades ==')
  const baja = await callController(stockMoves.createAdjustment, {
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
    body: { location_id: ubic.id, lines: [{ product_id: ron.id, qty: -3 }], notes: 'Producto quebrado' },
  })
  assert(baja.status === 200 || baja.status === 201, `el ajuste responde ok (${baja.status})`)

  let r = await postPendingOperations(prisma, user.id, co.id)
  let asientos = await asientosDeAjuste()
  assert(asientos.length === 1, `un asiento por el ajuste — hubo ${asientos.length} (omitidos: ${JSON.stringify(r.skipped)})`)
  const merma = asientos[0]
  const debeCosto = merma.lines.find((l) => l.account_id === costoId)
  const haberInv = merma.lines.find((l) => l.account_id === inventarioId)
  assert(Number(debeCosto.debit) === 75, `la merma carga 3 × 25 = 75 al costo de ventas — cargó ${debeCosto.debit}`)
  assert(Number(haberInv.credit) === 75, 'y acredita la misma cifra al inventario')

  console.log('\n== 2. Sobrante: aparecen 2 unidades ==')
  await callController(stockMoves.createAdjustment, {
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
    body: { location_id: ubic.id, lines: [{ product_id: ron.id, qty: 2 }] },
  })
  await postPendingOperations(prisma, user.id, co.id)
  asientos = await asientosDeAjuste()
  assert(asientos.length === 2, `ahora son dos asientos — hubo ${asientos.length}`)
  const sobrante = asientos[1]
  assert(Number(sobrante.lines.find((l) => l.account_id === inventarioId).debit) === 50,
    'el sobrante carga 2 × 25 = 50 al inventario')
  assert(Number(sobrante.lines.find((l) => l.account_id === costoId).credit) === 50,
    'contra el costo de ventas')

  console.log('\n== 3. Un ajuste de varias líneas es un solo asiento ==')
  const vodka = await prisma.product.create({
    data: {
      name: 'Vodka', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 90, cost: 10, stock: 0, min_stock: 0,
    },
  })
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[vodka.id, 10]]), suc.id, { reason: 'PURCHASE' }))
  await callController(stockMoves.createAdjustment, {
    companyId: co.id, branchId: suc.id, user: { sub: user.id },
    body: { location_id: ubic.id, lines: [{ product_id: ron.id, qty: -4 }, { product_id: vodka.id, qty: -1 }] },
  })
  await postPendingOperations(prisma, user.id, co.id)
  asientos = await asientosDeAjuste()
  assert(asientos.length === 3, `tres asientos, no cuatro — hubo ${asientos.length}`)
  assert(Number(asientos[2].lines.find((l) => l.account_id === costoId).debit) === 110,
    '4 × 25 + 1 × 10 = 110 en un solo asiento')

  console.log('\n== 4. Volver a contabilizar no duplica nada ==')
  await postPendingOperations(prisma, user.id, co.id)
  asientos = await asientosDeAjuste()
  assert(asientos.length === 3, `siguen siendo tres — hubo ${asientos.length}`)

  console.log('\n== 5. El inventario contable cuadra con la valuación física ==')
  const saldo = await prisma.journalLine.aggregate({
    where: { account_id: inventarioId, entry: { company_id: co.id, source_type: 'STOCK_ADJUSTMENT' } },
    _sum: { debit: true, credit: true },
  })
  const movidoPorAjustes = Number(saldo._sum.debit) - Number(saldo._sum.credit)
  // Ajustes en unidades: −3 +2 −4 de ron (25) y −1 de vodka (10).
  assert(movidoPorAjustes === -135,
    `los ajustes movieron −135 en la cuenta de inventario — movieron ${movidoPorAjustes}`)

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
