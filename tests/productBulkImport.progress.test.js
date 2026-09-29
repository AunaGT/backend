const test = require('node:test')
const assert = require('node:assert/strict')

test('consulta solo los códigos de barras presentes en la importación', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const stockPath = require.resolve('../src/services/stockLocations')
  const servicePath = require.resolve('../src/services/bulkImport')
  let productWhere
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    productCategory: { findMany: async () => [] },
    supplier: { findMany: async () => [] },
    product: { findMany: async ({ where }) => { productWhere = where; return [] } },
  } } }
  require.cache[stockPath] = { id: stockPath, filename: stockPath, loaded: true, exports: { applyBranchDelta: async () => {} } }
  delete require.cache[servicePath]
  try {
    const { validateBulkData } = require(servicePath)
    await validateBulkData([{ codigo_barras: '123' }, { barcode: '456' }, { barcode: '123' }], {}, { companyId: 'co-a' })
    assert.deepEqual(productWhere.barcode.in, ['123', '456'])
    assert.equal(productWhere.company_id, 'co-a')
  } finally {
    delete require.cache[servicePath]
    delete require.cache[stockPath]
    delete require.cache[prismaPath]
  }
})

test('crea productos independientes con concurrencia limitada y avance confirmado', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const stockPath = require.resolve('../src/services/stockLocations')
  const servicePath = require.resolve('../src/services/bulkImport')
  let active = 0
  let maximum = 0
  const progress = []
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    product: { create: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return { id: `p-${maximum}` } } },
    productStock: { create: async () => {} },
  } } }
  require.cache[stockPath] = { id: stockPath, filename: stockPath, loaded: true, exports: { applyBranchDelta: async () => {} } }
  delete require.cache[servicePath]
  try {
    const { bulkCreateProducts } = require(servicePath)
    const rows = Array.from({ length: 9 }, (_, i) => ({ rowIndex: i + 2, data: { name: `Producto ${i}`, stock: 0, category_id: 1, supplier_id: 1 } }))
    const result = await bulkCreateProducts(rows, { companyId: 'co-a', branchId: 'branch-a' }, event => progress.push(event))
    assert.equal(result.created, 9)
    assert.ok(maximum > 1 && maximum <= 4)
    assert.equal(progress.at(-1).processed, 9)
  } finally {
    delete require.cache[servicePath]
    delete require.cache[stockPath]
    delete require.cache[prismaPath]
  }
})
