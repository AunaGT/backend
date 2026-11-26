const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const req = (permissions = [], role = { name: 'Encargado' }) => ({ companyId, branchId, user: { sub: userId, role, permissions } })

test('payment notices need their own authority and confirming also needs receivables authority', () => {
  const { noticeScope } = require('../src/modules/cash-closure/notices.access')
  for (const permissions of [[], ['sales.create'], ['settings.manage'], ['receivables.manage'], ['cashclosure.approve'], ['cash.transfers.operate_team']])
    for (const action of ['view', 'create', 'confirm']) assert.throws(() => noticeScope(req(permissions), action), e => e.status === 403, `${permissions} ${action}`)
  assert.equal(noticeScope(req(['cash.notices.create']), 'create').canCreate, true)
  assert.throws(() => noticeScope(req(['cash.notices.create', 'receivables.manage']), 'confirm'), e => e.status === 403)
  assert.throws(() => noticeScope(req(['cash.digital.confirm']), 'confirm'), e => e.status === 403, 'confirming creates a receivable payment')
  assert.equal(noticeScope(req(['cash.digital.confirm', 'receivables.manage']), 'confirm').canConfirm, true)
  assert.equal(noticeScope(req(['cash.digital.confirm', 'receivables.manage']), 'view').canView, true)
  assert.throws(() => noticeScope({ companyId, branchId, integrationCredential: { id: 'k' } }, 'create'), e => e.status === 401, 'an API key never registers or confirms notices')
  assert.equal(noticeScope(req([], admin), 'confirm').isAdmin, true)
})

test('notice permissions are registered only for the canonical admin and listed in the catalog', async () => {
  const { registerCashPolicyPermissionsForAdmin, registerCashNoticePermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const rows = [{ id: 1, code: 'sales.create' }], grants = [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }]
  const db = { role: { findUnique: async () => admin }, permission: { upsert: async ({ create }) => {
    let row = rows.find(r => r.code === create.code); if (!row) rows.push(row = { id: rows.length + 1, ...create }); return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const g of data) if (!grants.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)) grants.push(g) } } }
  db.$transaction = fn => fn(db)
  await registerCashPolicyPermissionsForAdmin(db); const before = grants.length
  await registerCashNoticePermissionsForAdmin(db); await registerCashNoticePermissionsForAdmin(db)
  assert.deepEqual(rows.slice(-2).map(r => r.code), ['cash.notices.create', 'cash.digital.confirm']); assert.equal(grants.length, before + 2)
  assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }])
  const { permissions } = require('../src/config/permissionCatalog')
  for (const code of ['cash.notices.create', 'cash.digital.confirm']) assert.ok(permissions.some(p => p.code === code), code)
  assert.deepEqual(require('../src/config/permissionDeps').IMPLIES['cash.digital.confirm'], ['cash.notices.create'])
})
