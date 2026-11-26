const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const req = (permissions = [], role = { name: 'Gerente' }) => ({ companyId, branchId, user: { sub: userId, role, permissions } })

test('closing the day needs its own permission; reviewers may only read it', () => {
  const { dailyScope } = require('../src/modules/cash-closure/dailyConsolidation.access')
  for (const permissions of [[], ['sales.create'], ['cashclosure.view'], ['cash.settlements.manage'], ['settings.manage']])
    for (const action of ['view', 'finalize']) assert.throws(() => dailyScope(req(permissions), action), e => e.status === 403, `${permissions} ${action}`)
  assert.equal(dailyScope(req(['cashclosure.approve']), 'view').canFinalize, false)
  assert.throws(() => dailyScope(req(['cashclosure.approve']), 'finalize'), e => e.status === 403)
  assert.equal(dailyScope(req(['cash.day.close']), 'finalize').canFinalize, true)
  assert.throws(() => dailyScope({ companyId, branchId, integrationCredential: { id: 'k' } }, 'view'), e => e.status === 401)
  assert.equal(dailyScope(req([], admin), 'finalize').isAdmin, true)
})

test('the day permission is registered only for the canonical admin and listed in the catalog', async () => {
  const { registerCashSettlementPermissionsForAdmin, registerCashDailyPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const rows = [{ id: 1, code: 'sales.create' }], grants = [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }]
  const db = { role: { findUnique: async () => admin }, permission: { upsert: async ({ create }) => {
    let row = rows.find(r => r.code === create.code); if (!row) rows.push(row = { id: rows.length + 1, ...create }); return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const g of data) if (!grants.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)) grants.push(g) } } }
  db.$transaction = fn => fn(db)
  await registerCashSettlementPermissionsForAdmin(db); const before = grants.length
  await registerCashDailyPermissionsForAdmin(db); await registerCashDailyPermissionsForAdmin(db)
  assert.equal(rows.at(-1).code, 'cash.day.close'); assert.equal(grants.length, before + 1)
  assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }])
  assert.ok(require('../src/config/permissionCatalog').permissions.some(p => p.code === 'cash.day.close'))
})
