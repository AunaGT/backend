const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID(), id = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const request = (permissions, body = {}, role = { name: 'Contador' }) => ({ companyId, branchId, user: { sub: userId, name: 'QA', role, permissions }, body, query: {}, params: { versionId: id, settlementId: id } })
async function call(api, action, req) { const res = jsonResponse(); const headers = {}; res.set = (k, v) => { headers[k] = v; return res }; let error; await api[action](req, res, e => error = e); return { res, error, headers } }

test('settlement HTTP adapters keep their gates, approval stays with the admin and nothing is cached', async () => {
  const paths = { methods: require.resolve('../src/modules/cash-closure/bankMethods'), service: require.resolve('../src/modules/cash-closure/settlements'), controller: require.resolve('../src/modules/cash-closure/settlements.controller'), prisma: require.resolve('../src/models/prisma') }
  const db = { $transaction: fn => fn(db) }, calls = []
  const approve = async (_, s) => { if (!s.isAdmin) throw Object.assign(new Error('Solo el administrador'), { status: 403 }); calls.push('approve'); return { version: { id, status: 'APPROVED' } } }
  await withMocks({ [paths.prisma]: { prisma: db }, [paths.methods]: { approveBankMethod: approve, rejectBankMethod: approve, proposeBankMethod: async () => { calls.push('propose'); return { version: { id } } } },
    [paths.service]: { settlementsAvailable: async () => true, createSettlement: async (_, s, input) => { calls.push('settle'); return { replayed: input.replay === true, settlement: { id } } } } }, paths.controller, async api => {
    for (const permissions of [[], ['sales.create'], ['receivables.manage'], ['cash.settlements.manage']]) assert.equal((await call(api, 'propose', request(permissions))).error.status, 403, String(permissions))
    for (const permissions of [[], ['cash.bank_methods.manage'], ['receivables.manage']]) assert.equal((await call(api, 'create', request(permissions))).error.status, 403, String(permissions))
    assert.equal((await call(api, 'approve', request(['cash.bank_methods.manage']))).error.status, 403, 'a manager never approves')
    assert.equal((await call(api, 'approve', request([], {}, admin))).res.statusCode, 200)
    const fresh = await call(api, 'create', request(['cash.settlements.manage']))
    assert.equal(fresh.res.statusCode, 201); assert.equal(fresh.headers['Cache-Control'], 'private, no-store')
    assert.equal((await call(api, 'create', request(['cash.settlements.manage'], { replay: true }))).res.statusCode, 200)
    assert.equal((await call(api, 'create', { ...request(['cash.settlements.manage']), integrationCredential: { id: 'k' } })).error.status, 401)
    assert.deepEqual(calls, ['approve', 'settle', 'settle'])
    const caps = (await call(api, 'capabilities', request(['cash.bank_methods.manage']))).res.body
    assert.deepEqual(caps, { available: true, canManage: true, canApprove: false, canSettle: false })
  })
})
