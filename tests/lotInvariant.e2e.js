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
  const { defaultLocationId } = require('../src/services/stockLocations')
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

  await prisma.productLot.deleteMany({ where: { product_id: product.id, location_id: locationId } })
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
}

main()
  .then(() => console.log('lotInvariant.e2e OK'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
