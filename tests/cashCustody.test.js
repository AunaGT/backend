const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const req = (permissions = [], role = { name: 'Cajero' }) => ({ companyId, branchId, user: { sub: userId, role, permissions } })

test('custody authority is its own and never inherited from sales, configuration or physical movements', () => {
  const { custodyScope } = require('../src/modules/cash-closure/custody.access')
  for (const permissions of [[], ['sales.create'], ['settings.manage'], ['cashclosure.create'], ['cash.registers.manage'], ['cash.movements.create_team']])
    for (const action of ['send', 'receive', 'manage']) assert.throws(() => custodyScope(req(permissions), action), e => e.status === 403, `${permissions} ${action}`)
  assert.throws(() => custodyScope(req([], { name: 'Admin' }), 'send'), e => e.status === 403)
  assert.throws(() => custodyScope({ companyId, branchId, integrationCredential: { id: 'key' } }, 'send'), e => e.status === 401)
  assert.throws(() => custodyScope({ ...req([], admin), branchId: 'all' }, 'send'), e => e.status === 403)
  assert.equal(custodyScope(req(['cash.transfers.operate_own']), 'send').canOperateTeam, false)
  assert.equal(custodyScope(req(['cash.transfers.operate_team']), 'send').canOperateTeam, true)
  assert.throws(() => custodyScope(req(['cash.transfers.operate_own']), 'receive'), e => e.status === 403, 'sending does not allow receiving')
  assert.throws(() => custodyScope(req(['cash.custody.view']), 'manage'), e => e.status === 403)
  assert.equal(custodyScope(req([], admin), 'receive').isAdmin, true)
})

test('custody dependencies only grant the matching read', () => {
  const { expandPermissions } = require('../src/config/permissionDeps')
  for (const code of ['cash.custody.manage', 'cash.transfers.operate_own', 'cash.transfers.operate_team', 'cash.transfers.receive'])
    assert.deepEqual(expandPermissions([code]).sort(), [code, 'cash.custody.view'].sort(), code)
})

test('targeted custody registration adds five codes only to the canonical admin and keeps earlier grants', async () => {
  const { registerCashMovementPermissionsForAdmin, registerCashCustodyPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const rows = [{ id: 1, code: 'sales.create' }], grants = [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }]
  const db = { role: { findUnique: async () => admin }, permission: { upsert: async ({ create }) => {
    let row = rows.find(r => r.code === create.code); if (!row) rows.push(row = { id: rows.length + 1, ...create }); return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const g of data) if (!grants.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)) grants.push(g) } } }
  db.$transaction = fn => fn(db)
  await registerCashMovementPermissionsForAdmin(db); const before = structuredClone(grants)
  await registerCashCustodyPermissionsForAdmin(db); await registerCashCustodyPermissionsForAdmin(db)
  assert.deepEqual(rows.slice(-5).map(r => r.code).sort(), ['cash.custody.manage', 'cash.custody.view', 'cash.transfers.operate_own', 'cash.transfers.operate_team', 'cash.transfers.receive'])
  assert.equal(grants.length, before.length + 5)
  assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }])
})

test('custody legs affect drawer cash once without becoming sales, collections, refunds or physical movements', () => {
  const { summarizeMoneyEvents, mergeTheoretical } = require('../src/modules/cash-closure/eventTheoretical')
  const base = { payment_method_id: 1, payment_method_name: 'Efectivo', settlement_kind: 'CASH', currency_code: 'GTQ', recorded_at: '2026-10-30T12:00:00Z', economic_at: '2026-10-30T12:00:00Z', content_hash: 'a'.repeat(64) }
  const e = (id, source_type, direction, amount) => ({ ...base, id, source_id: id, source_type, direction, amount })
  const session = { id: 's', currency_code: 'GTQ', opening_float: 200, opening_cash_method_id: 1, opening_cash_method_name: 'Efectivo' }
  const r = summarizeMoneyEvents([e('a', 'SALE', 'IN', '100.00'), e('b', 'CUSTODY_ENTRY', 'OUT', '150.00'), e('c', 'CUSTODY_ENTRY', 'IN', '50.00')], { session, start: base.recorded_at, end: '2026-10-31T00:00:00Z' })
  assert.equal(r.cash_session.expected_cash_in_drawer, 200)
  assert.equal(r.theoretical.total_custody_out, 150); assert.equal(r.theoretical.total_custody_in, 50)
  assert.equal(r.theoretical.total_sales, 100); assert.equal(r.theoretical.total_returns, 0); assert.equal(r.theoretical.total_collections, 0)
  assert.equal(r.theoretical.total_cash_in, 0); assert.equal(r.theoretical.total_cash_out, 0)
  const legacy = { theoretical: { total_sales: 0, total_returns: 0, total_collections: 0, net_total: 0 }, payment_breakdown: [], collections: [], return_settlements: [], advance_refunds: [], metrics: { total_transactions: 0, total_customers: 0 }, unidentified_collections_amount: 0 }
  assert.equal(mergeTheoretical(legacy, r).theoretical.total_custody_out, 150, 'older snapshots without the field count as 0')
})
