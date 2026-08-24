/**
 * Uso: levantar un Postgres local/vacío, DATABASE_URL/DIRECT_URL apuntando a él,
 * npx prisma migrate deploy, y node tests/lotInvariant.e2e.js
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
  console.log('  ok:', msg)
}

async function physical(locationId, productId) {
  const row = await prisma.productStockLocation.findUnique({
    where: { product_id_location_id: { product_id: productId, location_id: locationId } },
    select: { stock: true },
  })
  return Number(row?.stock || 0)
}

async function traced(locationId, productId) {
  const result = await prisma.productLot.aggregate({
    where: { product_id: productId, location_id: locationId },
    _sum: { qty_remaining: true },
  })
  return Number(result._sum.qty_remaining || 0)
}

async function main() {
  const { restoreStockMap, deductStockMap } = require('../src/services/bomStock')
  const { defaultLocationId, moveBetweenLocations } = require('../src/services/stockLocations')
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const stockStatus = await prisma.stockStatus.upsert({
    where: { name: 'Disponible' }, update: {}, create: { name: 'Disponible' },
  })
  const company = await prisma.company.create({ data: { name: 'Lots invariant', code: `LI${suffix}` } })
  const branch = await prisma.branch.create({ data: { company_id: company.id, name: 'Central', code: `LI${suffix.slice(-7)}` } })
  const category = await prisma.productCategory.create({ data: { name: `Lots ${suffix}`, company_id: company.id } })
  const supplier = await prisma.supplier.create({ data: { name: `Lots ${suffix}`, contact: 'test', company_id: company.id } })
  const product = await prisma.product.create({
    data: {
      name: `Lots ${suffix}`, company_id: company.id, category_id: category.id, supplier_id: supplier.id,
      status_id: stockStatus.id, price: 1, cost: 1, stock: 0, min_stock: 0,
    },
  })
  const locationId = await prisma.$transaction((tx) => defaultLocationId(tx, branch.id))

  await prisma.$transaction((tx) => restoreStockMap(
    tx, new Map([[product.id, 6]]), branch.id,
    { reason: 'MANUAL_ADJUST', locationId }
  ))
  assert(await physical(locationId, product.id) === 6, 'physical stock is six')
  assert(await traced(locationId, product.id) === 6, 'automatic lot is also six')

  const warehouse = await prisma.warehouse.create({
    data: { branch_id: branch.id, name: 'Secondary', code: `S${suffix.slice(-8)}` },
  })
  const destinationId = (await prisma.stockLocation.create({
    data: { warehouse_id: warehouse.id, code: 'SHELF' },
  })).id
  const originalLot = await prisma.productLot.findFirst({
    where: { product_id: product.id, location_id: locationId }, select: { lot_code: true },
  })
  await prisma.$transaction((tx) => moveBetweenLocations(tx, {
    branchId: branch.id, fromLocationId: locationId, toLocationId: destinationId,
    lines: [{ product_id: product.id, qty: 2 }],
  }))
  assert(await physical(locationId, product.id) === 4 && await traced(locationId, product.id) === 4,
    'internal move keeps source physical and traced stock equal')
  assert(await physical(destinationId, product.id) === 2 && await traced(destinationId, product.id) === 2,
    'internal move keeps destination physical and traced stock equal')
  assert((await prisma.productLot.findFirst({
    where: { product_id: product.id, location_id: destinationId }, select: { lot_code: true },
  })).lot_code === originalLot.lot_code, 'internal move preserves lot code')
  await prisma.$transaction((tx) => moveBetweenLocations(tx, {
    branchId: branch.id, fromLocationId: destinationId, toLocationId: locationId,
    lines: [{ product_id: product.id, qty: 2 }],
  }))
  const productsController = require('../src/controllers/products.controller')
  let lotsResponse = null
  await productsController.getLots(
    { params: { id: product.id }, branchId: branch.id, companyId: company.id },
    { json: (body) => { lotsResponse = body } },
    (error) => { throw error },
  )
  assert(JSON.stringify(lotsResponse.reconciliation) === JSON.stringify({
    physical: 6, traced: 6, difference: 0, consistent: true,
  }), 'lot API returns exact physical/traced reconciliation')
  assert(lotsResponse.lots.every((lot) => lot.location?.code && lot.location?.warehouse?.code),
    'lot API includes location and warehouse codes')

  await prisma.productLot.deleteMany({ where: { product_id: product.id, location_id: locationId } })
  const [branchStock, productStock, movementCount] = await Promise.all([
    prisma.productStock.findUnique({
      where: { product_id_branch_id: { product_id: product.id, branch_id: branch.id } },
      select: { stock: true },
    }),
    prisma.product.findUnique({ where: { id: product.id }, select: { stock: true } }),
    prisma.stockMovement.count({ where: { product_id: product.id } }),
  ])
  let rejected = null
  try {
    await prisma.$transaction((tx) => deductStockMap(
      tx, new Map([[product.id, 1]]), branch.id,
      { reason: 'MANUAL_ADJUST', locationId }
    ))
  } catch (error) {
    rejected = error
  }
  assert(rejected?.code === 'LOT_STOCK_MISMATCH', 'missing lots reject the physical deduction')
  assert(await physical(locationId, product.id) === 6, 'failed lot deduction leaves physical stock unchanged')
  assert((await prisma.productStock.findUnique({
    where: { product_id_branch_id: { product_id: product.id, branch_id: branch.id } },
    select: { stock: true },
  })).stock === branchStock.stock, 'failed lot deduction leaves branch stock unchanged')
  assert((await prisma.product.findUnique({ where: { id: product.id }, select: { stock: true } })).stock === productStock.stock,
    'failed lot deduction leaves product stock unchanged')
  assert(await prisma.stockMovement.count({ where: { product_id: product.id } }) === movementCount,
    'failed lot deduction leaves no stock movement')
}

main()
  .then(() => console.log('lotInvariant.e2e OK'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
