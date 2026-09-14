/**
 * Archivar un producto no puede dejar existencias huérfanas, pedidos apuntando
 * al vacío ni kits con un componente muerto.
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

async function main() {
  const stockStatus = await prisma.stockStatus.upsert({
    where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' },
  })
  const { restoreStockMap, deductStockMap } = require('../src/services/bomStock')
  const products = require('../src/modules/inventory/products.controller')

  const co = await prisma.company.create({ data: { name: 'Archivo SA', code: `AR${Date.now() % 100000}` } })
  const suc = await prisma.branch.create({ data: { company_id: co.id, name: 'Central', code: 'CTR', is_default: true } })
  const cat = await prisma.productCategory.create({ data: { name: 'Licores', company_id: co.id } })
  const sup = await prisma.supplier.create({ data: { name: 'Prov', contact: 'c', company_id: co.id } })
  const nuevo = (name) => prisma.product.create({
    data: {
      name, company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 100, cost: 60, stock: 0, min_stock: 0,
    },
  })
  const req = { companyId: co.id, branchId: suc.id, user: { sub: null } }

  console.log('\n== 1. Con existencias no se archiva ==')
  const conStock = await nuevo('Con existencias')
  await prisma.$transaction((tx) => restoreStockMap(tx, new Map([[conStock.id, 4]]), suc.id, { reason: 'PURCHASE' }))
  const r1 = await callController(products.remove, { ...req, params: { id: conStock.id } })
  assert(r1.status === 400 && r1.body.code === 'PRODUCT_HAS_STOCK',
    'se rechaza y dice dónde están las unidades')
  assert(r1.body.message.includes('Central (4)'), `el mensaje nombra la sucursal y la cantidad: "${r1.body.message}"`)

  console.log('\n== 2. En cero sí se archiva ==')
  await prisma.$transaction((tx) => deductStockMap(tx, new Map([[conStock.id, 4]]), suc.id, { reason: 'MANUAL_ADJUST' }))
  const r2 = await callController(products.remove, { ...req, params: { id: conStock.id } })
  assert(r2.body?.ok === true, 'con las existencias ajustadas a 0, se archiva')
  const archivado = await prisma.product.findUnique({ where: { id: conStock.id }, select: { deleted: true } })
  assert(archivado.deleted === true, 'y queda marcado como archivado')

  console.log('\n== 3. Componente de un kit no se archiva ==')
  const componente = await nuevo('Componente')
  const kit = await prisma.product.create({
    data: {
      name: 'Kit fiesta', company_id: co.id, category_id: cat.id, supplier_id: sup.id,
      status_id: stockStatus.id, price: 300, cost: 200, stock: 0, min_stock: 0, kind: 'KIT',
    },
  })
  await prisma.productBomLine.create({
    data: { kit_product_id: kit.id, component_product_id: componente.id, qty_per_unit: 2 },
  })
  const r3 = await callController(products.remove, { ...req, params: { id: componente.id } })
  assert(r3.status === 400 && r3.body.code === 'PRODUCT_IN_KIT',
    'se rechaza y nombra el kit que lo usa')
  assert(r3.body.message.includes('Kit fiesta'), `el mensaje dice cuál: "${r3.body.message}"`)

  console.log('\n== 4. Comprometido en un pedido no se archiva ==')
  const reservado = await nuevo('Reservado')
  const doc = await prisma.commercialDocument.create({
    data: {
      branch_id: suc.id, doc_type: 'ORDER', reference: `P-CTR-${Date.now() % 900000}`,
      customer: 'Cliente', subtotal: 300, total: 300,
      lines: { create: [{ product_id: reservado.id, qty: 3, unit_price: 100, line_total: 300 }] },
    },
    include: { lines: true },
  })
  await prisma.stockReservation.create({
    data: {
      product_id: reservado.id, branch_id: suc.id, document_id: doc.id,
      document_line_id: doc.lines[0].id, qty: 3, status: 'ACTIVE',
    },
  })
  const r4 = await callController(products.remove, { ...req, params: { id: reservado.id } })
  assert(r4.status === 400 && r4.body.code === 'PRODUCT_HAS_RESERVATIONS',
    'se rechaza mientras haya reservas activas')

  console.log('\nTODAS LAS PRUEBAS PASARON')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
