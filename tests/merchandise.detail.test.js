const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET ||= 'merchandise-test-only-secret-at-least-32-characters'

test('detalle de mercancía entrega imágenes reales sin alterar costos ni saldo', async () => {
  const dbPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/merchandise/controller')
  const previous = require.cache[dbPath]
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: {
    incomingMerchandise: { findFirst: async ({ where, include }) => {
      assert.equal(where.branch.company_id, 'company-a')
      assert.equal(include.items.include.product.select.image_url, true)
      return { id: 'receipt', supplier: { id: 'supplier', name: 'Proveedor' }, registeredBy: { id: 'user', name: 'Usuario' }, date: new Date(), payment_status: 'PARTIAL', paymentEntries: [{ id: 'payment', amount: 5, paid_at: new Date() }], items: [{ id: 'line', product: { id: 'product', name: 'Producto', image_url: '/product.png' }, quantity: 3, unit_cost: 10 }] }
    } }
  } } }
  try {
    delete require.cache[controllerPath]
    let data
    await require(controllerPath).getById({ params: { id: 'receipt' }, companyId: 'company-a' }, { json: value => { data = value } }, error => { throw error })
    assert.equal(data.items[0].product.image_url, '/product.png')
    assert.equal(data.totalValue, 30)
    assert.equal(data.amount_pending, 25)
  } finally {
    delete require.cache[controllerPath]
    if (previous) require.cache[dbPath] = previous
    else delete require.cache[dbPath]
  }
})

test('el reporte conserva la búsqueda y el aislamiento de la sucursal del listado', async () => {
  const dbPath = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/merchandise/controller')
  const previous = require.cache[dbPath]
  let query
  const stop = new Error('stop before PDF rendering')
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { incomingMerchandise: { findMany: async args => { query = args; throw stop } } } } }
  try {
    delete require.cache[controllerPath]
    await require(controllerPath).generateReport({ companyId: 'company-a', branchId: 'branch-a', query: { search: 'Proveedor', payment_status: 'PARTIAL' } }, {}, error => { assert.equal(error, stop) })
    assert.equal(query.where.branch_id, 'branch-a')
    assert.equal(query.where.payment_status, 'PARTIAL')
    assert.equal(query.where.OR[0].supplier.name.contains, 'Proveedor')
  } finally {
    delete require.cache[controllerPath]
    if (previous) require.cache[dbPath] = previous
    else delete require.cache[dbPath]
  }
})
