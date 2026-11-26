const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID(), id = randomUUID()
const request = (permissions, body = {}) => ({ companyId, branchId, user: { sub: userId, name: 'QA', role: { name: 'Encargado' }, permissions }, body, query: {}, params: { id, sessionId: id } })
async function call(api, action, req) { const res = jsonResponse(); const headers = {}; res.set = (k, v) => { headers[k] = v; return res }; let error; await api[action](req, res, e => error = e); return { res, error, headers } }
const paths = () => ({ flow: require.resolve('../src/modules/cash-closure/reviewFlow'), policy: require.resolve('../src/modules/cash-closure/policy'),
  controller: require.resolve('../src/modules/cash-closure/reviewFlow.controller'), prisma: require.resolve('../src/models/prisma') })

test('review HTTP adapters keep their own gates and never cache', async () => {
  const { flow, policy, controller, prisma } = paths(), db = { $transaction: fn => fn(db) }
  const calls = []
  await withMocks({ [prisma]: { prisma: db }, [flow]: { finalize: async (_, s, closureId, input) => { calls.push(['finalize', s.userId, closureId, input.reason]); return { id: closureId, status: 'Aprobado' } },
    requestRecount: async (_, s, closureId) => { calls.push(['recount', closureId]); return { id: closureId, status: 'Reconteo' } } },
  [policy]: { savePolicy: async (_, s, input) => { calls.push(['policy', s.isAdmin, input.cashThreshold]); return { effective: {} } }, reviewAvailable: async () => true } }, controller, async api => {
    for (const permissions of [[], ['sales.create'], ['cashclosure.create_own'], ['cashclosure.view'], ['cash.policies.manage']])
      for (const action of ['finalize', 'recount']) assert.equal((await call(api, action, request(permissions))).error.status, 403, `${permissions} ${action}`)
    for (const permissions of [[], ['cashclosure.approve'], ['settings.manage']]) assert.equal((await call(api, 'savePolicy', request(permissions))).error.status, 403, String(permissions))
    const done = await call(api, 'finalize', request(['cashclosure.approve'], { reason: 'ok', expectedUpdatedAt: 'x' }))
    assert.equal(done.res.statusCode, 200); assert.equal(done.headers['Cache-Control'], 'private, no-store'); assert.equal(done.res.body.status, 'Aprobado')
    assert.equal((await call(api, 'recount', request(['cashclosure.validate'], { reason: 'r' }))).res.body.status, 'Reconteo')
    assert.equal((await call(api, 'savePolicy', request(['cash.policies.manage'], { cashThreshold: '1.00' }))).res.statusCode, 200)
    assert.deepEqual(calls, [['finalize', userId, id, 'ok'], ['recount', id], ['policy', false, '1.00']])
  })
})

test('without the review schema the capabilities say unavailable instead of offering actions', async () => {
  const { policy, controller, prisma } = paths()
  await withMocks({ [prisma]: { prisma: {} }, [policy]: { reviewAvailable: async () => false } }, controller, async api => {
    const { res, error } = await call(api, 'capabilities', request(['cashclosure.approve']))
    assert.equal(error, undefined); assert.deepEqual(res.body, { available: false, canReview: true, canManagePolicy: false, canDeclare: false, isAdmin: false })
  })
})

test('review routes are registered before the closure id route', () => {
  const router = require('../src/modules/cash-closure/routes')
  const paths = router.stack.filter(l => l.route).map(l => Object.keys(l.route.methods)[0].toUpperCase() + ' ' + l.route.path)
  for (const route of ['GET /review/capabilities', 'GET /review/policy', 'PUT /review/policy', 'GET /review/sessions/:sessionId/state', 'GET /:id/review', 'POST /:id/recount', 'POST /:id/finalize'])
    assert.ok(paths.includes(route), route)
  assert.ok(paths.indexOf('GET /review/policy') < paths.indexOf('GET /:id'))
})
