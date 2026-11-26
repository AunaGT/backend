const test = require('node:test'), assert = require('node:assert/strict')
const canonical = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
test('the unit preload cannot reload active environment credentials through a later import', () => {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(process.execPath, ['--require', './tests/setup-env.js', '-e', "require('./src/config/loadEnv');require('./src/modules/sales/cashRegisters.access');require('node:assert/strict').equal(process.env.DATABASE_URL,undefined);require('node:assert/strict').equal(process.env.ENV_FILE,'/dev/null');require('node:assert/strict').throws(()=>require('./src/models/prisma').prisma.user.findMany(),/unit test/i)"], { cwd: require('node:path').resolve(__dirname, '..'), env: { PATH: process.env.PATH, ENV_FILE: '/an/unsafe/path/that/the/preload/must/replace' }, encoding: 'utf8' })
  assert.equal(result.status, 0, 'The test preload must prevent loading any non-test env file')
})
function request(permissions = [], role = { name: 'Operador' }) { return { companyId: 'c', branchId: 'b', user: { sub: 'u', role, permissions } } }
test('register configuration authority requires its own capability and a selected branch', () => {
  const { cashRegisterAccess } = require('../src/modules/sales/cashRegisters.access')
  for (const req of [request(['settings.manage']), request([], { name: 'Admin' }), request(['sales.create']), request(['cashclosure.approve'])]) {
    assert.throws(() => cashRegisterAccess(req, 'manage'), e => e.status === 403)
  }
  assert.equal(cashRegisterAccess(request(['cash.registers.manage']), 'manage').userId, 'u')
  assert.equal(cashRegisterAccess(request(['cash.registers.view']), 'view').branchId, 'b')
  assert.throws(() => cashRegisterAccess(request(['cash.registers.view']), 'manage'), e => e.status === 403)
  assert.equal(cashRegisterAccess(request([], canonical), 'manage').isAdmin, true)
  assert.equal(cashRegisterAccess(request(['settings.manage']), 'legacy-manage').isAdmin, false)
  assert.throws(() => cashRegisterAccess({ ...request([], canonical), branchId: 'all' }, 'manage'), e => e.status === 400 || e.status === 403)
  assert.throws(() => cashRegisterAccess({ ...request([], canonical), companyId: null }, 'manage'), e => e.status === 400 || e.status === 403)
  assert.throws(() => cashRegisterAccess({ companyId: 'c', branchId: 'b' }, 'view'), e => e.status === 401)
})
test('register manage implies metadata only, never money or broader system authority', () => {
  const { expandPermissions } = require('../src/config/permissionDeps')
  assert.deepEqual(expandPermissions(['cash.registers.manage']).sort(), ['cash.registers.manage', 'cash.registers.view'])
  for (const code of ['settings.manage', 'sales.create', 'cashclosure.create', 'cashclosure.approve']) assert.equal(expandPermissions([code]).includes('cash.registers.manage'), false)
})
test('targeted registration adds only two codes to the canonical admin and preserves other roles', async () => {
  const { registerCashPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const permissions = [{ id: 99, code: 'old.permission' }], grants = [{ role_id: 112, permission_id: 99 }, { role_id: 139, permission_id: 99 }]
  const db = { role: { findUnique: async () => canonical }, permission: { upsert: async ({ create }) => {
    let row = permissions.find(p => p.code === create.code); if (!row) { row = { id: permissions.length + 100, ...create }; permissions.push(row) } return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const row of data) if (!grants.some(g => g.role_id === row.role_id && g.permission_id === row.permission_id)) grants.push(row) } } }
  db.$transaction = async fn => fn(db)
  await registerCashPermissionsForAdmin(db); await registerCashPermissionsForAdmin(db)
  assert.deepEqual(permissions.map(p => p.code).sort(), ['cash.registers.manage', 'cash.registers.view', 'old.permission'])
  assert.equal(grants.length, 4); assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 99 }, { role_id: 139, permission_id: 99 }])
  assert.equal(grants.some(g => g.role_id === 1 && g.permission_id === 99), false)
})
test('targeted registration rejects aliases before writing any catalog data', async () => {
  const { registerCashPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  for (const role of [null, { ...canonical, company_id: 'c' }, { id: 2, name: 'Admin' }]) {
    let writes = 0; const db = { role: { findUnique: async () => role }, permission: { upsert: async () => { writes++ } } }; db.$transaction = async fn => fn(db)
    await assert.rejects(registerCashPermissionsForAdmin(db), /admin/i); assert.equal(writes, 0)
  }
})
