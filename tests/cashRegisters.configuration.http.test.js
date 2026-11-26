const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const controller = require.resolve('../src/modules/sales/cashSessions.controller'), prisma = require.resolve('../src/models/prisma')
const config = require.resolve('../src/modules/sales/cashRegisters.configuration')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID(), id = randomUUID()
const req = (permissions, body = {}) => ({ companyId, branchId, user: { sub: userId, role: { name: 'Gestor' }, permissions }, params: { id }, query: {}, body })
async function call(api, action, request) { const res = jsonResponse(); res.set = () => res; let error; await api[action](request, res, e => { error = e }); return { res, error } }
test('advanced adapters use scoped configuration authority, not settings or monetary permissions', async () => {
  let writes = 0
  const db = { $transaction: fn => fn(db) }
  await withMocks({ [prisma]: { prisma: db }, [config]: { saveRegisterConfiguration: async (_, scope, input) => { writes++; return { id: input.id || id, scope, replayed: false } } } }, controller, async api => {
    for (const permissions of [['settings.manage'], ['sales.create'], ['cash.registers.view']]) assert.equal((await call(api, 'saveConfiguration', req(permissions))).error.status, 403)
    const result = await call(api, 'saveConfiguration', req(['cash.registers.manage'], { name: 'Caja', requestKey: randomUUID(), expectedRevision: 2 }))
    assert.equal(result.error, undefined); assert.equal(result.res.body.scope.branchId, branchId); assert.equal(result.res.body.id, id); assert.equal(writes, 1)
    assert.equal((await call(api, 'saveConfiguration', req(['cash.registers.manage'], { id: randomUUID() }))).error.status, 400)
  })
})
test('metadata-only register readers do not query or return money, sessions or a global user directory', async () => {
  const db = { cashRegister: { findMany: async options => { assert.equal(options.where.branch_id, branchId); assert.equal(options.include?.sessions, undefined); return [{ id, name: 'Caja', branch_id: branchId }] } }, $queryRaw: async () => [{ available: false }] }
  await withMocks({ [prisma]: { prisma: db } }, controller, async api => {
    const { res, error } = await call(api, 'listRegisters', req(['cash.registers.view']))
    assert.equal(error, undefined); assert.equal(res.body[0].id, id)
    for (const field of ['open_session', 'sessions', 'opening_float', 'assigned_users']) assert.equal(field in res.body[0], false)
  })
})
test('legacy adapters reject advanced fields before querying and require the active branch', async () => {
  const db = { $transaction: fn => fn(db), $queryRaw: async () => [] }
  await withMocks({ [prisma]: { prisma: db } }, controller, async api => {
    for (const [action, body] of [['updateRegister', { authorizedUserIds: [userId] }], ['createRegister', { name: 'Caja', money_event_version: 1 }], ['setRegisterUsers', { user_ids: [], access_control_version: 1 }]]) {
      const { error } = await call(api, action, req(['settings.manage'], body)); assert.equal(error?.status, 400)
    }
    for (const [action, body] of [['updateRegister', { name: 'Ajena' }], ['setRegisterUsers', { user_ids: [] }]]) {
      const { error } = await call(api, action, req(['settings.manage'], body)); assert.equal(error?.status, 404)
    }
  })
})
