const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const request = (permissions, body = {}) => ({ companyId, branchId, user: { sub: userId, name: 'QA', role: { name: 'Gerente' }, permissions }, body, query: {}, params: { date: '2026-11-01' } })
async function call(api, action, req) { const res = jsonResponse(); const headers = {}; res.set = (k, v) => { headers[k] = v; return res }; let error; await api[action](req, res, e => error = e); return { res, error, headers } }

test('day HTTP adapters: reviewers read, only the day permission finalizes, nothing is cached', async () => {
  const paths = { service: require.resolve('../src/modules/cash-closure/dailyConsolidation'), controller: require.resolve('../src/modules/cash-closure/dailyConsolidation.controller'), prisma: require.resolve('../src/models/prisma') }
  const db = { $transaction: fn => fn(db) }, calls = []
  await withMocks({ [paths.prisma]: { prisma: db }, [paths.service]: { dayView: async (_, s, date) => { calls.push(['view', date]); return { status: 'PROVISIONAL', contentKey: 'k' } },
    finalizeDay: async (_, s, date, input) => { calls.push(['finalize', date]); return { replayed: input.replay === true, view: { status: 'FINALIZED' } } } } }, paths.controller, async api => {
    for (const permissions of [[], ['sales.create'], ['cashclosure.view'], ['cash.settlements.manage']]) assert.equal((await call(api, 'view', request(permissions))).error.status, 403, String(permissions))
    const read = await call(api, 'view', request(['cashclosure.approve']))
    assert.equal(read.res.body.canFinalize, false); assert.equal(read.headers['Cache-Control'], 'private, no-store')
    assert.equal((await call(api, 'finalize', request(['cashclosure.approve']))).error.status, 403)
    assert.equal((await call(api, 'finalize', request(['cash.day.close']))).res.statusCode, 201)
    assert.equal((await call(api, 'finalize', request(['cash.day.close'], { replay: true }))).res.statusCode, 200)
    assert.equal((await call(api, 'view', { ...request(['cash.day.close']), integrationCredential: { id: 'k' } })).error.status, 401)
    assert.deepEqual(calls.map(c => c[0]), ['view', 'finalize', 'finalize'])
  })
})
