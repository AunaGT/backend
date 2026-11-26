const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID(), id = randomUUID()
const request = (permissions, body = {}) => ({ companyId, branchId, user: { sub: userId, role: { name: 'Cajero' }, permissions }, body, query: {}, params: { transferId: id, sessionId: id } })
async function call(api, action, req) { const res = jsonResponse(); const headers = {}; res.set = (k, v) => { headers[k] = v; return res }; let error; await api[action](req, res, e => error = e); return { res, error, headers } }
const paths = () => ({ service: require.resolve('../src/modules/cash-closure/custody'), controller: require.resolve('../src/modules/cash-closure/custody.controller'), prisma: require.resolve('../src/models/prisma') })

test('custody HTTP adapters keep their own gates, never cache and return idempotent receipts', async () => {
  const { service, controller, prisma } = paths(), db = { $transaction: fn => fn(db) }
  let sent = 0
  await withMocks({ [prisma]: { prisma: db }, [service]: { sendTransfer: async (_, scope, input) => { assert.equal(scope.branchId, branchId); sent++; return { replayed: input.replay === true, transfer: { id } } },
    receiveTransfer: async () => ({ replayed: false, transfer: { id, status: 'RECEIVED' } }) } }, controller, async api => {
    for (const permissions of [[], ['sales.create'], ['cash.registers.manage'], ['cashclosure.create'], ['cash.movements.create_team'], ['cash.custody.view'], ['cash.transfers.receive']])
      assert.equal((await call(api, 'send', request(permissions))).error.status, 403, String(permissions))
    const fresh = await call(api, 'send', request(['cash.transfers.operate_own']))
    assert.equal(fresh.res.statusCode, 201); assert.equal(fresh.headers['Cache-Control'], 'private, no-store')
    assert.equal((await call(api, 'send', request(['cash.transfers.operate_team'], { replay: true }))).res.statusCode, 200); assert.equal(sent, 2)
    assert.equal((await call(api, 'receive', request(['cash.transfers.operate_team']))).error.status, 403, 'sending authority does not receive')
    assert.equal((await call(api, 'receive', request(['cash.transfers.receive']))).res.statusCode, 201)
  })
})

test('without the custody schema the capabilities say unavailable instead of offering actions', async () => {
  const { service, controller, prisma } = paths()
  await withMocks({ [prisma]: { prisma: {} }, [service]: { custodyAvailable: async () => false } }, controller, async api => {
    const { res, error } = await call(api, 'capabilities', request(['cash.transfers.operate_own']))
    assert.equal(error, undefined); assert.equal(res.body.available, false); assert.equal(res.body.canOperateOwn, true)
  })
})
