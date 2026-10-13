const test = require('node:test')
const assert = require('node:assert/strict')

test('catálogos: búsqueda, orden y paginación mantienen el aislamiento por empresa', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const paths = ['paymentTerms', 'productCategories'].map(name => require.resolve(`../src/modules/catalogs/${name}.controller`))
  const previous = require.cache[prismaPath]
  let query
  const model = {
    count: async ({ where }) => { assert.equal(where.company_id, 'company-a'); return 13 },
    findMany: async args => { query = args; return [{ id: 1, name: 'Bebidas' }] },
  }
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: { paymentTerm: model, productCategory: model } } }
  try {
    for (const path of paths) {
      delete require.cache[path]
      const controller = require(path)
      let response
      await controller.list({ companyId: 'company-a', query: { page: '99', pageSize: '10', search: ' Beb ', order: 'desc' } }, { json: data => { response = data } }, error => { throw error })
      assert.deepEqual(query.where, { deleted: false, company_id: 'company-a', name: { contains: 'Beb', mode: 'insensitive' } })
      assert.deepEqual(query.orderBy, { name: 'desc' })
      assert.equal(query.skip, 10)
      assert.equal(query.take, 10)
      assert.equal(response.page, 2)
      assert.equal(response.nextPage, null)
      await controller.list({ companyId: 'company-a', query: { includeDeleted: 'true', order: 'invalid' } }, { json: () => {} }, error => { throw error })
      assert.equal(query.where.deleted, undefined)
      assert.equal(query.orderBy.name, 'asc')
    }
  } finally {
    for (const path of paths) delete require.cache[path]
    if (previous) require.cache[prismaPath] = previous
    else delete require.cache[prismaPath]
  }
})
