const test = require('node:test')
const assert = require('node:assert/strict')
const { IMPLIES, expandPermissions } = require('../src/config/permissionDeps')

test('own/day cash closures do not silently grant the general capability', () => {
  for (const selected of ['cashclosure.create_own', 'cashclosure.create_day']) {
    const codes = expandPermissions([selected])
    assert.ok(codes.includes('cashclosure.view'))
    assert.ok(!codes.includes('cashclosure.create'))
    assert.ok(!codes.includes(selected.endsWith('own') ? 'cashclosure.create_day' : 'cashclosure.create_own'))
  }
  assert.ok(expandPermissions(['cashclosure.create']).includes('cashclosure.create'), 'explicit legacy grants remain explicit')
})
test('HR/payroll actions include their own read capability without broadening financial writes', () => {
  for (const [action, read] of [
    ['hr.employees.create', 'hr.employees.view'], ['hr.employees.edit', 'hr.employees.view'], ['hr.employees.delete', 'hr.employees.view'],
    ['hr.attendance.manage', 'hr.attendance.view'], ['hr.advances.manage', 'hr.advances.view'],
    ...['create', 'confirm', 'pay', 'cancel'].map(action => [`payroll.${action}`, 'payroll.view']),
  ]) assert.ok(expandPermissions([action]).includes(read), `${action} needs ${read}`)
  for (const action of ['appointments.collect', 'appointments.refund', 'appointments.issue_sale']) {
    assert.ok(!expandPermissions([action]).includes('receivables.manage'))
    assert.ok(!expandPermissions([action]).includes('sales.create'))
  }
  assert.ok(!expandPermissions(['hr.documents.view']).includes('hr.employees.view'), 'documents do not grant full employee files')
})
test('dependency expansion is idempotent, transitive and cycle-safe', () => {
  const codes = expandPermissions(['stock_moves.adjust', 'products.edit', 'products.edit'])
  assert.ok(codes.includes('warehouses.view'))
  assert.equal(new Set(codes).size, codes.length)
  assert.deepEqual(expandPermissions(codes).sort(), codes.sort())
  assert.deepEqual(expandPermissions(['analytics.view']), ['analytics.view'])
  assert.ok(expandPermissions(Object.keys(IMPLIES)).length > 0)
})
test('all dependencies reference the actual installation catalog, including imported modules', () => {
  const { permissions } = require('../src/config/permissionCatalog')
  const codes = new Set(permissions.map(p => p.code))
  assert.equal(codes.size, permissions.length, 'duplicate catalog entries')
  for (const [code, deps] of Object.entries(IMPLIES)) {
    assert.ok(codes.has(code), `${code} is missing`)
    for (const dependency of deps) assert.ok(codes.has(dependency), `${code} implies unknown ${dependency}`)
  }
  for (const code of ['appointments.view', 'appointments.issue_sale', 'appointments.collect', 'appointments.override_payment_policy', 'integrations.manage', 'hardware.view']) assert.ok(codes.has(code))
})
test('catalog registration is idempotent and never touches role grants', async () => {
  const { permissions, registerPermissions } = require('../src/config/permissionCatalog')
  const rows = new Map(), db = { permission: { upsert: async ({ where, update, create }) => rows.set(where.code, rows.has(where.code) ? { ...rows.get(where.code), ...update } : create) } }
  await registerPermissions(db); await registerPermissions(db)
  assert.equal(rows.size, permissions.length)
  assert.ok(rows.has('appointments.edit'))
})
test('permission catalog responses distinguish requirements from implicit grants',async()=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const rows=[{code:'appointments.collect'},{code:'orders.manage'}]
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{permission:{findMany:async()=>rows}}}},require.resolve('../src/modules/users/controller'),async controller=>{
    const res=jsonResponse();await controller.getPermissions({},res,error=>{throw error})
    assert.ok(res.body[0].requirements.some(r=>r.permissions.includes('receivables.manage')))
    assert.ok(!res.body[0].implies.includes('receivables.manage'))
    assert.ok(res.body[1].requirements.some(r=>r.permissions.includes('sales.create')))
  })
})
