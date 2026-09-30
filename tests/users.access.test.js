const test = require('node:test')
const assert = require('node:assert/strict')
const access = require('../src/services/userAccess')

test('un rol personalizado de otra empresa no se hereda del rol histórico', () => {
  const user = { id: 'u', role: { id: 5, name: 'supervisor', company_id: 'a' }, user_companies: [{ company_id: 'b', status: 'ACTIVE' }] }
  assert.throws(() => access.effectiveUser(user, 'b'), { status: 403 })
})

test('el rol empresarial reemplaza al global sin sumar privilegios', () => {
  const user = { id: 'u', role: { id: 1, name: 'admin' }, user_companies: [
    { company_id: 'a', status: 'ACTIVE', role: { id: 8, name: 'lector', permissions: [{ permission: { code: 'users.view' } }] } },
  ] }
  assert.equal(access.effectiveUser(user, 'a').role_id, 8)
  assert.deepEqual(access.effectiveUser(user, 'a').permissions, ['users.view'])
  assert.throws(() => access.effectiveUser(user, 'b'), { status: 403 })
})

test('acceso suspendido se bloquea aun conservando sucursal y rol admin', () => {
  const user = { role: { name: 'admin' }, user_companies: [{ company_id: 'a', status: 'BLOCKED' }] }
  assert.throws(() => access.effectiveUser(user, 'a'), { status: 403 })
})

test('el cambio obligatorio existe hasta que el usuario actualiza su contraseña', async () => {
  const client = { userAccessEvent: { findFirst: async () => ({ id: 'event-1' }) } }
  assert.equal(await access.requiresPasswordChange({ id: 'u1', password_changed_at: null }, client), true)
  assert.equal(await access.requiresPasswordChange({ id: 'u1', password_changed_at: new Date() }, client), false)
  assert.equal(await access.requiresPasswordChange({ id: 'u2', password_changed_at: null }, { userAccessEvent: { findFirst: async () => null } }), false)
})

test('filtros rechazan números inválidos y orden arbitrario', () => {
  assert.throws(() => access.listQuery({ page: 'NaN' }), { status: 400 })
  assert.throws(() => access.listQuery({ sort: 'password' }), { status: 400 })
  assert.deepEqual(access.listQuery({ page: '2', pageSize: '10', sort: 'email', direction: 'desc' }), {
    page: 2, pageSize: 10, orderBy: [{ email: 'desc' }, { id: 'asc' }],
  })
})

test('asignación no concede permisos superiores al actor ni un rol admin por nombre', () => {
  const actor = { permissions: ['users.create'] }
  assert.throws(() => access.assertGrant(actor, { name: 'admin', permissions: [] }), { status: 403 })
  assert.throws(() => access.assertGrant(actor, { name: 'ventas', permissions: [{ permission: { code: 'sales.delete' } }] }), { status: 403 })
  assert.doesNotThrow(() => access.assertGrant(actor, { name: 'crear', permissions: [{ permission: { code: 'users.create' } }] }))
})
