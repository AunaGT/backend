const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { companyId: id(1), branchId: id(2), userId: id(3), isAdmin: false }
const turn = extra => ({ id: id(4), cash_register_id: id(5), status: 'OPEN', opened_by_id: scope.userId,
  opened_at: new Date('2026-10-28T15:00:00Z'), register_active: true, register_kind: 'PHYSICAL', ...extra })
const boundary = () => require('../src/services/cashSessionBoundary')

test('a scoped session lock binds company, branch and session instead of accepting an arbitrary session row', async () => {
  const tx = { $queryRaw: async (sql, ...values) => {
    assert.match(sql.join('?'), /FOR UPDATE OF s/)
    assert.deepEqual(new Set(values), new Set([id(4), scope.companyId, scope.branchId]))
    return []
  } }
  await assert.rejects(boundary().lockScopedSession(tx, scope, id(4)), e => e.status === 404)
})
test('a register lock has explicit tenant scope and cannot resolve an inactive register', async () => {
  const tx = { $queryRaw: async (sql, ...values) => {
    assert.match(sql.join('?'), /FOR UPDATE OF r/)
    assert.deepEqual(new Set(values), new Set([id(5), scope.companyId, scope.branchId]))
    return []
  } }
  await assert.rejects(boundary().lockScopedRegister(tx, scope, id(5)), e => e.status === 404)
})
for (const [name, session, actor, options, status] of [
  ['closed turn', turn({ status: 'CLOSED' }), scope, { settlementKind: 'CASH' }, 409],
  ['inactive register', turn({ register_active: false }), scope, { settlementKind: 'CASH' }, 409],
  ['another operator', turn({ opened_by_id: id(9) }), scope, { settlementKind: 'CASH' }, 403],
  ['cash in a virtual register', turn({ register_kind: 'VIRTUAL' }), scope, { settlementKind: 'CASH' }, 409],
  ['a receipt before its turn', turn(), scope, { settlementKind: 'CASH', paidAt: new Date('2026-10-28T14:59:59Z') }, 400],
]) test(`new money rejects ${name}`, () => {
  assert.throws(() => boundary().assertSessionOperation(session, actor, options), e => e.status === status)
})
test('own physical money, canonical administrator override and digital virtual money keep their real timestamps', () => {
  const paidAt = new Date('2026-10-28T15:01:00Z')
  boundary().assertSessionOperation(turn(), scope, { settlementKind: 'CASH', paidAt })
  boundary().assertSessionOperation(turn({ opened_by_id: id(9) }), { ...scope, isAdmin: true }, { settlementKind: 'BANK' })
  boundary().assertSessionOperation(turn({ register_kind: 'VIRTUAL' }), scope, { settlementKind: 'BANK' })
  assert.equal(paidAt.toISOString(), '2026-10-28T15:01:00.000Z')
})
test('invalid identifiers and missing authenticated scope fail without sending a database query', async () => {
  const tx = { $queryRaw: async () => assert.fail('invalid input reached the database') }
  await assert.rejects(boundary().lockScopedSession(tx, scope, 'not-an-id'), e => e.status === 400)
  await assert.rejects(boundary().lockScopedSession(tx, { branchId: scope.branchId }, id(4)), e => e.status === 403)
})

const controller = require.resolve('../src/modules/sales/cashSessions.controller')
const prismaModule = require.resolve('../src/models/prisma')
function request(body) { return { companyId: scope.companyId, branchId: scope.branchId,
  user: { sub: scope.userId, role: { name: 'cashier' }, permissions: ['sales.create'] }, body, query: {} } }
test('opening rechecks the competing open turn after acquiring the register lock', async () => {
  let existing = null, created = 0
  const register = { id: id(5), branch_id: scope.branchId, active: true }
  const db = { cashRegister: { findFirst: async () => register },
    cashRegisterSession: { findFirst: async () => existing, create: async () => { created++; return turn() } },
    $queryRaw: async () => { existing = turn(); return [register] } }
  db.$transaction = async work => work(db)
  await withMocks({ [prismaModule]: { prisma: db } }, controller, async api => {
    const response = jsonResponse()
    await api.openSession(request({ cash_register_id: id(5), opening_float: 0 }), response, e => { throw e })
    assert.equal(response.statusCode, 409); assert.equal(created, 0)
  })
})
test('closing does not overwrite the first closer after a stale open-session lookup', async () => {
  const session = turn({ notes: 'Original' }); let writes = 0
  const db = { cashRegister: { findFirst: async () => ({ id: id(5), active: true, branch_id: scope.branchId }) },
    cashRegisterSession: { findFirst: async () => ({ ...session }), updateMany: async () => { writes++; return { count: 1 } }, findUnique: async () => session },
    $queryRaw: async () => { session.status = 'CLOSED'; return [{ ...session }] } }
  db.$transaction = async work => work(db)
  await withMocks({ [prismaModule]: { prisma: db } }, controller, async api => {
    const response = jsonResponse()
    await api.closeSession(request({ cash_register_id: id(5), notes: 'Stale' }), response, e => { throw e })
    assert.equal(response.statusCode, 409); assert.equal(writes, 0); assert.equal(session.notes, 'Original')
  })
})
test('supervised termination targets the reviewed turn, never a replacement opened meanwhile', async () => {
  let writes = 0
  const db = { cashRegister: { findFirst: async () => ({ id: id(5), branch_id: scope.branchId, active: true }) }, cashRegisterSession: { findFirst: async () => turn({ id: id(9) }), updateMany: async () => { writes++; return { count: 1 } }, findUnique: async () => turn({ id: id(9) }) }, $queryRaw: async () => [turn({ id: id(9) })] }
  db.$transaction = async work => work(db)
  await withMocks({ [prismaModule]: { prisma: db } }, controller, async api => {
    const response = jsonResponse()
    await api.closeSession(request({ cash_register_id: id(5), cash_register_session_id: id(4) }), response, e => { throw e })
    assert.equal(response.statusCode, 409); assert.equal(writes, 0)
  })
})
