#!/usr/bin/env node
/**
 * Prueba de integración end-to-end contra una Postgres desechable.
 * Ejercita los controladores reales (no mocks de lógica de negocio) para
 * validar dos correcciones:
 *
 *   1. Compras del período excluye inventario inicial (clasificación por
 *      `source` en PurchaseLog / IncomingMerchandise).
 *   2. Existencias consistentes entre products.stock / product_stocks /
 *      product_stock_locations tras traslado + venta + devolución.
 *
 * Solo para correr contra una base descartable (DATABASE_URL apunta a ella).
 * Sale con código 1 si alguna aserción falla.
 */

const bcrypt = require('bcryptjs')
const { prisma, prismaTransaction } = require('../src/models/prisma')
const productsCtrl = require('../src/modules/inventory/products.controller')
const transfersCtrl = require('../src/modules/transfers/controller')
const salesCtrl = require('../src/modules/sales/controller')
const returnsCtrl = require('../src/modules/returns/controller')
const analyticsCtrl = require('../src/modules/analytics/controller')
const { getFinancialData } = require('../src/modules/reports/controller')

const DEFAULT_COMPANY_ID = '00000000-0000-4000-8000-000000000001'

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  OK  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}`)
  }
}

function call(fn, req) {
  return new Promise((resolve, reject) => {
    let done = false
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this },
      json(body) { if (!done) { done = true; resolve({ status: this.statusCode, body }) } },
    }
    // Igual que el error handler global de Express: un error con .status se
    // traduce a esa respuesta HTTP, no a un reject (así el test puede leer
    // status/body como lo haría el cliente real).
    const toResponse = (e) => ({ status: e?.status || 500, body: { message: e?.message || String(e) } })
    const next = (err) => { if (!done) { done = true; resolve(toResponse(err)) } }
    Promise.resolve(fn(req, res, next)).catch((e) => { if (!done) { done = true; resolve(toResponse(e)) } })
  })
}

async function main() {
  console.log('== Preparando datos de soporte ==')
  const category = await prisma.productCategory.create({ data: { name: 'Licores-test', company_id: DEFAULT_COMPANY_ID } })
  const status = await prisma.stockStatus.findFirst({ where: { name: 'Disponible' } })
  const supplier = await prisma.supplier.create({
    data: { company_id: DEFAULT_COMPANY_ID, name: 'Proveedor Test', contact: 'Test' },
  })
  const password = await bcrypt.hash('Test1234!', 10)
  const adminRole = await prisma.role.findFirst({ where: { name: { equals: 'admin', mode: 'insensitive' } } })
  const mainBranch = await prisma.branch.findFirst({ where: { company_id: DEFAULT_COMPANY_ID, is_default: true } })
  const villaNueva = await prisma.branch.create({
    data: { company_id: DEFAULT_COMPANY_ID, name: 'Villa Nueva', code: 'VNTEST' },
  })
  await prisma.cashRegister.create({
    data: { branch_id: villaNueva.id, name: 'Caja Villa Nueva', code: 'VN-PRIN', is_default: true },
  })
  const user = await prisma.user.create({
    data: {
      name: 'Tester', email: `tester-${Date.now()}@ejemplo.com`, password,
      role_id: adminRole.id, default_branch_id: mainBranch.id,
    },
  })
  await prisma.userCompany.create({ data: { user_id: user.id, company_id: DEFAULT_COMPANY_ID } })
  await prisma.userBranch.createMany({
    data: [{ user_id: user.id, branch_id: mainBranch.id }, { user_id: user.id, branch_id: villaNueva.id }],
  })

  const baseReq = { companyId: DEFAULT_COMPANY_ID, user: { sub: user.id, role_name: 'admin' } }

  console.log('== Problema 1: producto con stock inicial (10 u @ Q25 en Mixco) ==')
  const productRes = await call(productsCtrl.create, {
    ...baseReq,
    branchId: mainBranch.id,
    body: {
      name: 'Producto Test', category_id: category.id, status_id: status.id,
      supplier_id: supplier.id, price: 40, cost: 25, stock: 10,
    },
  })
  assert(productRes.status === 201, 'producto creado (201)')
  const product = productRes.body.product
  const purchaseLogInitial = await prisma.purchaseLog.findFirst({ where: { product_id: product.id } })
  assert(purchaseLogInitial?.source === 'INITIAL', 'purchase_log del stock inicial quedó marcado INITIAL')
  const supplierAfterInitial = await prisma.supplier.findUnique({ where: { id: supplier.id } })
  assert(Number(supplierAfterInitial.total_purchases) === 0, 'total_purchases del proveedor NO subió por el stock inicial')

  console.log('== Problema 1: compra real (1 u @ Q33.75, producto aparte) ==')
  const productPurchaseRes = await call(productsCtrl.create, {
    ...baseReq, branchId: mainBranch.id,
    body: {
      name: 'Producto Test Compra', category_id: category.id, status_id: status.id,
      supplier_id: supplier.id, price: 60, cost: 30, stock: 0,
    },
  })
  const productPurchase = productPurchaseRes.body.product
  const incomingRes = await call(productsCtrl.registerIncomingMerchandise, {
    ...baseReq,
    branchId: mainBranch.id,
    body: {
      supplier_id: supplier.id,
      items: [{ product_id: productPurchase.id, quantity: 1, unit_cost: 33.75 }],
    },
  })
  assert(incomingRes.status === 201 || incomingRes.status === 200, 'entrada de mercancía registrada')
  const supplierAfterPurchase = await prisma.supplier.findUnique({ where: { id: supplier.id } })
  assert(Number(supplierAfterPurchase.total_purchases) === 33.75, 'total_purchases del proveedor SÍ subió con la compra real (33.75)')

  const startUtc = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const endUtc = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const financial = await getFinancialData(startUtc, endUtc, { companyId: DEFAULT_COMPANY_ID, branchId: null })
  assert(Math.abs(financial.purchasesPeriod - 33.75) < 0.001, `Reportes: purchasesPeriod = 33.75 (obtenido ${financial.purchasesPeriod})`)
  assert(Math.abs(financial.initialInventoryPeriod - 250) < 0.001, `Reportes: initialInventoryPeriod = 250 (obtenido ${financial.initialInventoryPeriod})`)

  const analyticsRes = await call(analyticsCtrl.summary, {
    ...baseReq, branchId: null, query: { year: 'all' },
  })
  assert(Math.abs(analyticsRes.body.purchases.total - 33.75) < 0.001, `Análisis: purchases.total = 33.75 (obtenido ${analyticsRes.body.purchases.total})`)

  console.log('== Problema 1 (Análisis): carga masiva de inventario inicial vía entrada de mercancía ==')
  const product2Res = await call(productsCtrl.create, {
    ...baseReq, branchId: mainBranch.id,
    body: {
      name: 'Producto Test 2', category_id: category.id, status_id: status.id,
      supplier_id: supplier.id, price: 20, cost: 10, stock: 0,
    },
  })
  const product2 = product2Res.body.product
  const bulkInitialRes = await call(productsCtrl.registerIncomingMerchandise, {
    ...baseReq, branchId: mainBranch.id,
    body: {
      supplier_id: supplier.id, is_initial_load: true,
      items: [{ product_id: product2.id, quantity: 5, unit_cost: 10 }],
    },
  })
  assert(bulkInitialRes.status === 201 || bulkInitialRes.status === 200, 'carga inicial masiva registrada')
  const analyticsRes2 = await call(analyticsCtrl.summary, { ...baseReq, branchId: null, query: { year: 'all' } })
  assert(Math.abs(analyticsRes2.body.purchases.total - 33.75) < 0.001,
    `Análisis: purchases.total sigue en 33.75 tras la carga inicial (obtenido ${analyticsRes2.body.purchases.total})`)
  assert(Math.abs(analyticsRes2.body.initialInventory.total - 50) < 0.001,
    `Análisis: initialInventory.total = 50 (obtenido ${analyticsRes2.body.initialInventory.total})`)

  console.log('== Problema 2: traslado 3 u Mixco -> Villa Nueva, recibir, vender 1, devolver ==')
  const transferRes = await call(transfersCtrl.create, {
    ...baseReq, branchId: mainBranch.id,
    body: { to_branch_id: villaNueva.id, items: [{ product_id: product.id, qty: 3 }] },
  })
  assert(transferRes.status === 201, 'traslado creado')
  const transferId = transferRes.body.id

  console.log('== Bloqueo de doble recepción (2 requests concurrentes, no secuenciales) ==')
  const receiveReq = () => call(transfersCtrl.receive, {
    ...baseReq, branchId: villaNueva.id, params: { id: transferId }, body: {},
  })
  const [raceA, raceB] = await Promise.all([receiveReq(), receiveReq()])
  const statuses = [raceA.status, raceB.status].sort()
  assert(statuses[0] === 200 && (statuses[1] === 400 || statuses[1] === 409),
    `exactamente una recepción concurrente tuvo éxito (statuses: ${statuses.join(', ')})`)
  const stockVillaAfterRace = await prisma.productStock.findFirst({ where: { product_id: product.id, branch_id: villaNueva.id } })
  assert(stockVillaAfterRace.stock === 3, `Villa Nueva acreditada una sola vez = 3 (obtenido ${stockVillaAfterRace.stock})`)

  console.log('== Bloqueo de doble recepción (secuencial, ya RECIBIDA) ==')
  const doubleReceiveRes = await receiveReq()
  assert(doubleReceiveRes.status === 400, `tercer intento también bloqueado (status ${doubleReceiveRes.status})`)

  const paymentMethod = await prisma.paymentMethod.findFirst({ where: { name: 'Efectivo' } })
  const saleRes = await call(salesCtrl.create, {
    ...baseReq, branchId: villaNueva.id, get: () => null,
    body: { items: [{ product_id: product.id, qty: 1 }], payment_method_id: paymentMethod.id },
  })
  if (saleRes.status !== 201) console.log('  saleRes.body:', JSON.stringify(saleRes.body))
  assert(saleRes.status === 201, 'venta creada')
  const sale = saleRes.body

  const returnRes = await call(returnsCtrl.create, {
    ...baseReq, branchId: villaNueva.id,
    body: {
      sale_id: sale.id, type: 'REFUND', reason: 'Prueba de devolución',
      items: [{ sale_item_id: sale.sale_items[0].id, product_id: product.id, qty_returned: 1 }],
    },
  })
  if (returnRes.status !== 201) console.log('  returnRes.body:', JSON.stringify(returnRes.body))
  assert(returnRes.status === 201, 'devolución creada')
  const approveRes = await call(returnsCtrl.updateStatus, {
    ...baseReq, branchId: villaNueva.id, params: { id: returnRes.body.id },
    body: { status_name: 'Aprobada', restore_stock: true },
  })
  assert(approveRes.status === 200, 'devolución aprobada (stock restaurado)')

  console.log('== Verificando existencias (Mixco = 7, Villa Nueva = 3) ==')
  const stockMixco = await prisma.productStock.findFirst({ where: { product_id: product.id, branch_id: mainBranch.id } })
  const stockVilla = await prisma.productStock.findFirst({ where: { product_id: product.id, branch_id: villaNueva.id } })
  assert(stockMixco.stock === 7, `Mixco = 7 (obtenido ${stockMixco.stock})`)
  assert(stockVilla.stock === 3, `Villa Nueva = 3 (obtenido ${stockVilla.stock})`)

  const productMirror = await prisma.product.findUnique({ where: { id: product.id } })
  assert(productMirror.stock === 10, `espejo products.stock = 7+3=10 (obtenido ${productMirror.stock})`)

  const locSum = await prisma.$queryRaw`
    SELECT b.id AS branch_id, COALESCE(SUM(psl.stock), 0)::int AS total
    FROM branches b
    LEFT JOIN warehouses w ON w.branch_id = b.id
    LEFT JOIN stock_locations l ON l.warehouse_id = w.id
    LEFT JOIN product_stock_locations psl ON psl.location_id = l.id AND psl.product_id = ${product.id}::uuid
    WHERE b.id IN (${mainBranch.id}::uuid, ${villaNueva.id}::uuid)
    GROUP BY b.id
  `
  const locMixco = locSum.find((r) => r.branch_id === mainBranch.id)
  const locVilla = locSum.find((r) => r.branch_id === villaNueva.id)
  assert(locMixco?.total === 7, `ubicaciones Mixco = 7 (obtenido ${locMixco?.total})`)
  assert(locVilla?.total === 3, `ubicaciones Villa Nueva = 3 (obtenido ${locVilla?.total})`)

  console.log('== Análisis / Inventario (mismas tablas, mismo valor) ==')
  const dashboardValueRows = await prisma.productStock.findMany({
    where: { product_id: product.id },
    select: { branch_id: true, stock: true, product: { select: { cost: true } } },
  })
  const analyticaValor = dashboardValueRows.reduce((s, r) => s + r.stock * Number(r.product.cost), 0)
  const costoUnitario = Number(productMirror.cost)
  const unidadesTotales = stockMixco.stock + stockVilla.stock
  assert(Math.abs(analyticaValor - unidadesTotales * costoUnitario) < 0.001,
    `Valor analítico (${analyticaValor}) = unidades (${unidadesTotales}) × costo (${costoUnitario})`)

  console.log(`\n${failures === 0 ? 'TODO OK' : `${failures} ASERCIONES FALLARON`}`)
  return failures
}

main()
  .then((n) => process.exit(n === 0 ? 0 : 1))
  .catch((e) => { console.error('ERROR:', e); process.exit(2) })
  .finally(async () => { await prisma.$disconnect(); if (prismaTransaction !== prisma) await prismaTransaction.$disconnect() })
