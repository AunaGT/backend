const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET ||= 'commercial-summary-test-secret-at-least-32-characters'

const cases = [
  ['promotions', 'promotion', { total: 31, active: 12, scheduled: 7, ended: 9, inactive: 3 }],
  ['quotes', 'commercialDocument', { total: 31, draft: 12, sent: 7, accepted: 9 }],
  ['returns', 'return', { total: 31, pending: 12, approved: 7, completed: 9, rejected: 3 }],
  ['transfers', 'stockTransfer', { total: 31, inTransit: 12, received: 7, cancelled: 12 }],
  ['merchandise', 'incomingMerchandise', { total: 31, paid: 12, partial: 7, pending: 12 }],
]
for (const [moduleName, model, expected] of cases) {
  test(`${moduleName}: summaries cover filtered scope before pagination and are opt-in`, async () => {
    const dbPath = require.resolve('../src/models/prisma')
    const controllerPath = require.resolve(`../src/modules/${moduleName}/controller`)
    const previous = require.cache[dbPath]
    let baseWhere, extraCalls = 0, paginated = false, empty = false
    const statuses = moduleName === 'quotes' ? ['DRAFT', 'SENT', 'ACCEPTED'] : moduleName === 'transfers' ? ['EN_TRANSITO', 'RECIBIDA', 'CANCELADA'] : ['PAID', 'PARTIAL', 'PENDING']
    const counts = moduleName === 'transfers' || moduleName === 'merchandise' ? [12, 7, 12] : [12, 7, 9, 3]
    const db = {
      count: async ({ where }) => {
        assert.equal(paginated, false, 'aggregate before page retrieval')
        if (!baseWhere) { baseWhere = where; return empty ? 0 : 31 }
        assert.deepEqual(where.AND[0], baseWhere, 'status counts intersect every original filter')
        const index = extraCalls++
        if (moduleName === 'returns') assert.deepEqual(where.AND[1], {status:{name:['Pendiente','Aprobada','Completada','Rechazada'][index]}})
        if (moduleName === 'promotions') {
          assert.equal(where.AND[1].company_id, 'company-a')
          const condition = where.AND[1].AND[0]
          assert.equal(condition.active, index !== 3)
          if (index === 0) {assert.ok(condition.start_date.lte instanceof Date);assert.equal(condition.OR[0].end_date,null);assert.deepEqual(condition.OR[1].end_date.gt,condition.start_date.lte)}
          if (index === 1) assert.ok(condition.start_date.gt instanceof Date)
          if (index === 2) assert.ok(condition.end_date.lte instanceof Date)
        }
        return empty ? 0 : counts[index]
      },
      groupBy: async args => {
        assert.equal(paginated, false)
        if (!baseWhere && (moduleName === 'transfers' || moduleName === 'merchandise')) baseWhere = args.where
        assert.deepEqual(args.where, baseWhere)
        assert.equal(args.skip, undefined)
        assert.equal(args.take, undefined)
        extraCalls++
        assert.deepEqual(args.by, moduleName === 'merchandise' ? ['source','payment_status'] : ['status'])
        return empty ? [] : statuses.map((status, i) => ({ [moduleName === 'merchandise' ? 'payment_status' : 'status']: status, _count: { _all: counts[i] } }))
      },
      findMany: async args => {
        assert.deepEqual(args.where, baseWhere)
        assert.equal(args.take, 10)
        assert.equal(args.skip, empty ? 0 : 20)
        paginated = true
        return []
      },
    }
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { [model]: db } } }
    try {
      delete require.cache[controllerPath]
      const controller = require(controllerPath)
      const query = { includeSummary: 'true', page: '3', pageSize: '10', search: 'summer', reason: 'damaged', supplier_id: 'supplier-a' }
      let result
      const invoke = () => controller.list({ companyId: 'company-a', branchId: 'branch-a', query }, { json: value => { result = value } }, error => { throw error })
      await invoke()
      assert.deepEqual(result.summary, expected)
      assert.equal(result.items.length, 0, 'empty page cannot supply the summary')
      assert.equal(result.totalItems, 31)
      const scope = JSON.stringify(baseWhere)
      assert.match(scope, /branch-a/)
      assert.match(scope, /summer/)
      if (moduleName === 'promotions' || moduleName === 'transfers') assert.match(scope, /company-a/)
      baseWhere = null; extraCalls = 0; paginated = false; delete query.includeSummary
      await invoke()
      assert.equal(result.summary, undefined)
      assert.equal(extraCalls, 0, 'other callers pay no summary cost')
      baseWhere = null; extraCalls = 0; paginated = false; empty = true; query.includeSummary = 'true'
      query.status = moduleName === 'promotions' ? 'active' : moduleName === 'returns' ? 'Pendiente' : moduleName === 'quotes' ? 'DRAFT' : moduleName === 'transfers' ? 'EN_TRANSITO' : undefined
      query.payment_status = moduleName === 'merchandise' ? 'PAID' : undefined
      await invoke()
      assert.deepEqual(result.summary, Object.fromEntries(Object.keys(expected).map(key => [key, 0])))
      assert.match(JSON.stringify(baseWhere), new RegExp(query.status || query.payment_status))
    } finally {
      delete require.cache[controllerPath]
      if (previous) require.cache[dbPath] = previous
      else delete require.cache[dbPath]
    }
  })
}
