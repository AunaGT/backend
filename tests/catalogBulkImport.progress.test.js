const test = require('node:test')
const assert = require('node:assert/strict')

const prismaPath = require.resolve('../src/models/prisma')
const servicePath = require.resolve('../src/services/catalogBulkImport')

test('guarda categorías en lotes y comunica filas confirmadas', async () => {
  const batches = []
  const progress = []
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    productCategory: { createMany: async ({ data }) => { batches.push(data); return { count: data.length } } },
  } } }
  delete require.cache[servicePath]
  try {
    const { bulkCreateCatalogs } = require(servicePath)
    const rows = Array.from({ length: 101 }, (_, index) => ({ rowIndex: index + 1, data: { name: `Categoría ${index}` } }))
    const result = await bulkCreateCatalogs(rows, 'categories', 'company-a', (event) => progress.push(event))
    assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 1])
    assert.deepEqual(progress.map((event) => event.processed), [50, 100, 101])
    assert.equal(result.created, 101)
  } finally {
    delete require.cache[servicePath]
    delete require.cache[prismaPath]
  }
})
