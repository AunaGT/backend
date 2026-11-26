const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const req = (permissions = [], role = { name: 'Encargado' }) => ({ companyId, branchId, user: { sub: userId, role, permissions } })

test('reviewing and configuring policies need their own authority, never sales or cash operation', () => {
  const { reviewScope } = require('../src/modules/cash-closure/reviewFlow.access')
  for (const permissions of [[], ['sales.create'], ['settings.manage'], ['cashclosure.create_own'], ['cash.transfers.operate_team'], ['cash.custody.manage']])
    for (const action of ['review', 'policy']) assert.throws(() => reviewScope(req(permissions), action), e => e.status === 403, `${permissions} ${action}`)
  assert.throws(() => reviewScope(req([], { name: 'Admin' }), 'policy'), e => e.status === 403)
  assert.throws(() => reviewScope({ companyId, branchId, integrationCredential: { id: 'k' } }, 'review'), e => e.status === 401)
  assert.equal(reviewScope(req(['cashclosure.approve']), 'review').canReview, true)
  assert.throws(() => reviewScope(req(['cashclosure.approve']), 'policy'), e => e.status === 403)
  assert.equal(reviewScope(req(['cash.policies.manage']), 'policy').canManagePolicy, true)
  assert.equal(reviewScope(req([], admin), 'policy').isAdmin, true)
})

test('the policy permission is registered only for the canonical admin and keeps earlier grants', async () => {
  const { registerCashCustodyPermissionsForAdmin, registerCashPolicyPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const rows = [{ id: 1, code: 'sales.create' }], grants = [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }]
  const db = { role: { findUnique: async () => admin }, permission: { upsert: async ({ create }) => {
    let row = rows.find(r => r.code === create.code); if (!row) rows.push(row = { id: rows.length + 1, ...create }); return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const g of data) if (!grants.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)) grants.push(g) } } }
  db.$transaction = fn => fn(db)
  await registerCashCustodyPermissionsForAdmin(db); const before = grants.length
  await registerCashPolicyPermissionsForAdmin(db); await registerCashPolicyPermissionsForAdmin(db)
  assert.equal(rows.at(-1).code, 'cash.policies.manage'); assert.equal(grants.length, before + 1)
  assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }])
  const { permissions } = require('../src/config/permissionCatalog')
  assert.ok(permissions.some(p => p.code === 'cash.policies.manage'), 'listed in the installation catalog')
})

test('each payment method is classified against its own threshold and a surplus never covers a shortage', () => {
  const { classify } = require('../src/modules/cash-closure/policy')
  const cash = { breakdown_key: 'c', payment_method_id: 1, payment_method_name: 'Efectivo', settlement_kind: 'CASH', theoretical_amount: '100.00' }
  const card = { breakdown_key: 'd', payment_method_id: 2, payment_method_name: 'Tarjeta', settlement_kind: 'BANK', theoretical_amount: '50.00' }
  const policy = { cash_threshold: '5.00', digital_threshold: '0.00' }
  const row = (m, actual) => ({ breakdown_key: m.breakdown_key, payment_method_id: m.payment_method_id, actual_amount: actual })
  const within = classify([row(cash, '97.00'), row(card, '50.00')], [cash, card], policy)
  assert.equal(within.result, 'WITHIN'); assert.deepEqual(within.lines.map(l => [l.kind, l.difference, l.status]), [['CASH', '-3.00', 'WITHIN'], ['DIGITAL', '0.00', 'CLEAN']])
  assert.equal(classify([row(cash, '100.00'), row(card, '49.99')], [cash, card], policy).result, 'REVIEW', 'digital at 0.00 reviews a cent')
  const offset = classify([row(cash, '110.00'), row(card, '40.00')], [cash, card], { cash_threshold: '20.00', digital_threshold: '0.00' })
  assert.equal(offset.result, 'REVIEW', 'cash surplus does not cover the card shortage'); assert.equal(offset.lines[1].status, 'REVIEW')
  assert.equal(classify([row(cash, '100.00'), row(card, '50.00')], [cash, card], policy).result, 'CLEAN')
  assert.equal(classify([row(cash, '94.99'), row(card, '50.00')], [cash, card], policy).result, 'REVIEW')
})

test('policy resolution prefers the branch, keeps the owner exception company-wide and defaults to zero tolerance', async () => {
  const { resolvePolicy } = require('../src/modules/cash-closure/policy')
  const rows = []
  const db = { $queryRaw: async () => rows }
  assert.deepEqual(await resolvePolicy(db, companyId, branchId), { source: 'DEFAULT', cash_threshold: '0.00', digital_threshold: '0.00', blind_count: false, owner_self_review: false, revision: 0 })
  rows.push({ branch_id: null, cash_threshold: '10.00', digital_threshold: '1.00', blind_count: false, owner_self_review: true, revision: 3 })
  assert.equal((await resolvePolicy(db, companyId, branchId)).source, 'COMPANY')
  rows.push({ branch_id: branchId, cash_threshold: '2.00', digital_threshold: '0.00', blind_count: true, owner_self_review: false, revision: 1 })
  assert.deepEqual(await resolvePolicy(db, companyId, branchId), { source: 'BRANCH', cash_threshold: '2.00', digital_threshold: '0.00', blind_count: true, owner_self_review: true, revision: 1 })
})
