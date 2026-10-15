const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET ||= 'catalog-summary-test-secret-at-least-32-characters'

for (const [file, model, field, groups, expected] of [
  ['productCategories', 'productCategory', 'deleted', [[false, 24], [true, 7]], { total: 31, active: 24, deleted: 7 }],
  ['paymentTerms', 'paymentTerm', 'net_days', [[null, 7], [0, 5], [30, 12], [60, 7]], { total: 31, immediate: 5, credit: 19, unspecified: 7 }],
]) {
  test(`${file} summary uses the complete filtered scope, not its page, and is opt-in`, async () => {
    const dbPath = require.resolve('../src/models/prisma')
    const ctrlPath = require.resolve(`../src/modules/catalogs/${file}.controller`)
    const oldDb = require.cache[dbPath]
    let where, pageRead = false, aggregates = 0, empty = false, result
    const db = {
      count: async args => { where = args.where; return empty ? 0 : 31 },
      groupBy: async args => {
        assert.equal(pageRead, false)
        assert.deepEqual(args.where, where)
        assert.deepEqual(args.by, [field])
        assert.equal(args.take, undefined)
        assert.equal(args.skip, undefined)
        aggregates++
        return empty ? [] : groups.map(([value, count]) => ({ [field]: value, _count: { _all: count } }))
      },
      findMany: async args => {
        // Existing payment-method initialization is independent of the admin page.
        if (!args.where) return [{ id: 1, name: 'Existing method' }]
        assert.deepEqual(args.where, where)
        assert.equal(args.take, 1)
        pageRead = true
        return []
      },
    }
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { [model]: db } } }
    try {
      delete require.cache[ctrlPath]
      const controller = require(ctrlPath)
      const query = { page: '2', pageSize: '1', search: 'Bebidas', includeDeleted: 'true', includeSummary: 'true' }
      const invoke = () => controller.list({ companyId: 'company-a', query }, { json: data => { result = data } }, error => { throw error })
      await invoke()
      assert.deepEqual(result.summary, expected)
      assert.equal(result.items.length, 0)
      assert.equal(where.name.contains, 'Bebidas')
      if (file !== 'paymentMethods') assert.equal(where.company_id, 'company-a')
      assert.equal(aggregates, 1)
      delete query.includeSummary; pageRead = false; aggregates = 0
      await invoke()
      assert.equal(result.summary, undefined)
      assert.equal(aggregates, 0)
      query.includeSummary = 'true'; delete query.includeDeleted; pageRead = false; empty = true
      await invoke()
      assert.deepEqual(result.summary, Object.fromEntries(Object.keys(expected).map(key => [key, 0])))
      if (file !== 'paymentMethods') assert.equal(where.deleted, false)
    } finally {
      delete require.cache[ctrlPath]
      if (oldDb) require.cache[dbPath] = oldDb
      else delete require.cache[dbPath]
    }
  })
}
