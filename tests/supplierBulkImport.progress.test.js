const test = require('node:test')
const assert = require('node:assert/strict')

test('guarda contactos independientes con concurrencia limitada y progreso real', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const servicePath = require.resolve('../src/services/supplierBulkImport')
  let active = 0
  let maximum = 0
  const progress = []
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    paymentTerm: { findFirst: async () => ({ id: 1 }) },
    supplier: { create: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active-- } },
  } } }
  delete require.cache[servicePath]
  try {
    const { bulkCreateSuppliers } = require(servicePath)
    const rows = Array.from({ length: 9 }, (_, i) => ({ rowIndex: i + 2, data: { party_type: 'CUSTOMER', name: `Cliente ${i}`, payment_terms_use_default: true } }))
    const result = await bulkCreateSuppliers(rows, {}, { companyId: 'co-a' }, event => progress.push(event))
    assert.equal(result.created, 9)
    assert.ok(maximum > 1 && maximum <= 4)
    assert.equal(progress.at(-1).processed, 9)
  } finally {
    delete require.cache[servicePath]
    delete require.cache[prismaPath]
  }
})
