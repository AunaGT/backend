const test = require('node:test')
const assert = require('node:assert/strict')

// Exercise the controller; replace only database I/O, never tenant/filter logic.
const prismaPath = require.resolve('../src/models/prisma')
const controllerPath = require.resolve('../src/modules/inventory/stock.controller')
const previous = require.cache[prismaPath]
let calls = []
const prisma = {
  stockMovement: {
    count: async args => { calls.push(['count', args]); return 105 },
    findMany: async args => { calls.push(['find', args]); return [{ id: 'older-movement' }] },
  },
  systemSetting: { findMany: async () => [] },
}
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma } }
const controller = require(controllerPath)
if (previous) require.cache[prismaPath] = previous
else delete require.cache[prismaPath]

async function list(query, branchId = 'branch-a') {
  calls = []
  const result = { status: 200 }
  await controller.list({ branchId, companyId: 'company-a', query }, {
    status(code) { result.status = code; return this },
    json(body) { result.body = body },
  }, error => { result.error = error })
  return result
}

test('stock history reads beyond the first 100 with branch-scoped search and pagination', async () => {
  const result = await list({ page: '99', pageSize: '8', search: ' botella ', reason: 'SALE', location_id: 'shelf-a' })
  assert.equal(result.error, undefined)
  assert.equal(result.body.page, 14)
  assert.equal(result.body.totalPages, 14)
  assert.equal(result.body.totalItems, 105)
  assert.equal(result.body.prevPage, 13)
  assert.equal(result.body.nextPage, null)
  assert.deepEqual(result.body.items, [{ id: 'older-movement' }])
  const query = calls.find(([type]) => type === 'find')[1]
  assert.equal(query.skip, 104)
  assert.equal(query.take, 8)
  assert.equal(query.where.branch_id, 'branch-a')
  assert.equal(query.where.location_id, 'shelf-a')
  assert.equal(query.where.reason, 'SALE')
  assert.deepEqual(query.where.OR, [
    { product: { name: { contains: 'botella', mode: 'insensitive' } } },
    { product: { barcode: { contains: 'botella', mode: 'insensitive' } } },
    { notes: { contains: 'botella', mode: 'insensitive' } },
  ])
  assert.deepEqual(calls.find(([type]) => type === 'count')[1].where, query.where)
  assert.deepEqual(query.orderBy, [{ created_at: 'desc' }, { id: 'desc' }])
})

test('stock filters include the whole final day in the company timezone and reject invalid input', async () => {
  const result = await list({ page: '1', from: '2026-10-06', to: '2026-10-06' })
  assert.equal(result.error, undefined)
  const range = calls.find(([type]) => type === 'find')[1].where.created_at
  assert.equal(range.gte.toISOString(), '2026-10-06T06:00:00.000Z')
  assert.equal(range.lt.toISOString(), '2026-10-07T06:00:00.000Z')
  for (const query of [
    { page: '1', from: '2026-02-30' }, { page: '1', from: 'bad' },
    { page: '1', from: '2026-10-07', to: '2026-10-06' }, { page: '1', reason: 'INVALID' },
  ]) {
    const invalid = await list(query)
    assert.equal(invalid.status, 400)
    assert.equal(calls.length, 0)
  }
  const missingBranch = await list({ page: '1' }, null)
  assert.equal(missingBranch.error.status, 400)
  assert.equal(calls.length, 0)
})

test('stock list keeps legacy array callers and bounds malformed pagination', async () => {
  const legacy = await list({ limit: '20', product_id: 'product-a' })
  assert.deepEqual(legacy.body, [{ id: 'older-movement' }])
  assert.equal(calls[0][1].take, 20)
  assert.equal(calls[0][1].where.product_id, 'product-a')
  const paged = await list({ page: 'NaN', pageSize: '100000' })
  assert.equal(paged.body.page, 1)
  assert.equal(paged.body.pageSize, 100)
  assert.equal(calls.find(([type]) => type === 'find')[1].take, 100)
})
