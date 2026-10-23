// Controlled controller reads only; never connects to the development database.
require('../tests/setup-env')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('../tests/helpers/reportHarness.cjs')
const model = require.resolve('../src/models/prisma')

async function groupedList(kind) {
  const merchandise = kind === 'merchandise'
  const table = merchandise ? 'incomingMerchandise' : 'stockTransfer'
  const field = merchandise ? 'payment_status' : 'status'
  const statuses = merchandise ? ['PAID', 'PARTIAL', 'PENDING'] : ['EN_TRANSITO', 'RECIBIDA', 'CANCELADA']
  const calls = []
  const record = (method, query) => calls.push({ method, where: query.where })
  const db = { [table]: {
    count: async query => { record('count', query); return 9 },
    groupBy: async query => { record('groupBy', query); return statuses.map(status => ({ [field]: status, _count: { _all: 3 } })) },
    findMany: async query => { record('page', query); return [] },
  } }
  return withMocks({ [model]: { prisma: db } }, require.resolve(`../src/modules/${kind}/controller`), async controller => {
    const res = jsonResponse()
    await controller.list({ companyId: 'A', branchId: 'B', query: { page: '1', pageSize: '20', includeSummary: 'true' } }, res, error => { throw error })
    assert.equal(res.body.totalItems, 9)
    for (const call of calls) assert.deepEqual(call.where, calls[0].where)
    return { kind, calls: calls.map(call => call.method), sameWhere: true, summary: res.body.summary }
  })
}

async function stockWaves() {
  const calls = [], pending = [], waves = []
  let finished = false
  const db = { stockMovement: {
    count: query => {
      const quantity = query.where.AND?.[1]?.qty
      calls.push(quantity?.gt !== undefined ? 'count_positive' : quantity?.lt !== undefined ? 'count_negative' : 'count_total')
      return new Promise(resolve => pending.push(() => resolve(quantity ? 4 : 9)))
    },
    findMany: async () => { calls.push('page'); return [] },
  } }
  return withMocks({ [model]: { prisma: db } }, require.resolve('../src/modules/inventory/stock.controller'), async controller => {
    const res = jsonResponse()
    const run = controller.list({ companyId: 'A', branchId: 'B', query: { page: '1', includeSummary: 'true' } }, res, error => { throw error }).then(() => { finished = true })
    for (let wave = 0; wave < 5 && !finished; wave++) {
      await new Promise(setImmediate)
      waves.push([...calls])
      pending.splice(0).forEach(release => release())
    }
    assert.equal(finished, true, 'Controlled reads did not settle in five rounds')
    await run
    assert.deepEqual(res.body.summary, { total: 9, incoming: 4, outgoing: 4 })
    return { kind: 'stock', waves, summary: res.body.summary }
  })
}

async function main() {
  for (const kind of ['merchandise', 'transfers']) console.log(JSON.stringify(await groupedList(kind)))
  console.log(JSON.stringify(await stockWaves()))
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
