const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const admin = { id: 1, name: 'admin', system_key: 'ADMIN', company_id: null }
const req = (permissions = [], role = { name: 'Cajero' }) => ({ companyId, branchId, user: { sub: userId, role, permissions } })
test('physical cash authority is scoped and never inherited from sales or configuration', () => {
  const { physicalMovementScope } = require('../src/modules/cash-closure/physicalMovements.access')
  for (const permissions of [[], ['sales.create'], ['settings.manage'], ['cashclosure.create'], ['cash.registers.manage']]) assert.throws(() => physicalMovementScope(req(permissions), 'create'), e => e.status === 403)
  assert.throws(() => physicalMovementScope(req([], { name: 'Admin' }), 'create'), e => e.status === 403)
  assert.throws(() => physicalMovementScope({ ...req([], admin), branchId: 'all' }, 'create'), e => e.status === 400 || e.status === 403)
  assert.throws(() => physicalMovementScope({ companyId, branchId, integrationCredential: { id: 'key' } }, 'create'), e => e.status === 401)
  assert.equal(physicalMovementScope(req(['cash.movements.create_own']), 'create').canCreateTeam, false)
  assert.equal(physicalMovementScope(req(['cash.movements.create_team']), 'create').canCreateTeam, true)
  assert.throws(() => physicalMovementScope(req(['cash.movements.view_team']), 'create'), e => e.status === 403)
  assert.equal(physicalMovementScope(req([], admin), 'correct').isAdmin, true)
})
test('movement dependencies grant only the matching reads, never sales or closure authority', () => {
  const { expandPermissions } = require('../src/config/permissionDeps')
  assert.deepEqual(expandPermissions(['cash.movements.create_own']).sort(), ['cash.movements.create_own','cash.movements.view_own'])
  assert.deepEqual(expandPermissions(['cash.movements.create_team']).sort(), ['cash.movements.create_team','cash.movements.view_team'])
  assert.deepEqual(expandPermissions(['cash.movements.correct']).sort(), ['cash.movements.correct','cash.movements.view_own'])
})
test('targeted movement registration preserves all earlier grants and the two-code register contract', async () => {
  const { registerCashPermissionsForAdmin, registerCashMovementPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  const rows = [{ id: 1, code: 'sales.create' }], grants = [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }]
  const db = { role: { findUnique: async () => admin }, permission: { upsert: async ({ create }) => {
    let row = rows.find(r => r.code === create.code); if (!row) rows.push(row = { id: rows.length + 1, ...create }); return row
  } }, rolePermission: { createMany: async ({ data }) => { for (const g of data) if (!grants.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)) grants.push(g) } } }
  db.$transaction = fn => fn(db)
  await registerCashPermissionsForAdmin(db); const before = structuredClone(grants)
  await registerCashMovementPermissionsForAdmin(db); await registerCashMovementPermissionsForAdmin(db)
  assert.equal(rows.length, 8); assert.equal(grants.length, 9)
  assert.deepEqual(grants.filter(g => g.role_id !== 1), [{ role_id: 112, permission_id: 1 }, { role_id: 139, permission_id: 1 }])
  assert.deepEqual(grants.filter(g => before.some(r => r.role_id === g.role_id && r.permission_id === g.permission_id)), before)
  for (const role of [null, { name: 'Admin' }, { ...admin, company_id: companyId }]) await assert.rejects(registerCashMovementPermissionsForAdmin({ $transaction: fn => fn({ role: { findUnique: async () => role } }) }), /admin/i)
})
test('physical command rejects unsafe money and foreign authority fields and normalizes retry intent', () => {
  const { parsePhysicalMovement, physicalMovementHash } = require('../src/modules/cash-closure/physicalMovements')
  const valid = { requestKey: randomUUID(), cashRegisterSessionId: randomUUID(), direction: 'OUT', amount: '10.5', paymentMethodId: 2, reason: ' Retiro real ', counterpartyLabel: ' Resguardo ', reference: ' Sobre 1 ' }
  const parsed = parsePhysicalMovement(valid)
  assert.equal(parsed.amount, '10.50'); assert.equal(parsed.reason, 'Retiro real')
  assert.equal(physicalMovementHash(parsed), physicalMovementHash(parsePhysicalMovement({ ...valid, requestKey: randomUUID(), amount: '10.50', reason: 'Retiro real' })))
  for (const amount of ['0','-1','NaN','1e2','1.001','10000000000',10]) assert.throws(() => parsePhysicalMovement({ ...valid, amount }), e => e.status === 400)
  for (const input of [{ ...valid, reason: '' }, { ...valid, counterpartyLabel: ' ' }, { ...valid, actorId: userId }, { ...valid, expectedBalance: '999' }, { ...valid, direction: 'BANK' }]) assert.throws(() => parsePhysicalMovement(input), e => e.status === 400)
  const correction = { requestKey: randomUUID(), cashRegisterSessionId: randomUUID(), reason: 'Efectivo devuelto' }
  assert.throws(() => parsePhysicalMovement({ ...correction, amount: '10' }, { originalId: randomUUID() }), e => e.status === 400)
})
test('physical movements affect drawer cash without becoming sales, collections or refunds', () => {
  const { summarizeMoneyEvents } = require('../src/modules/cash-closure/eventTheoretical')
  const at='2026-10-30T01:00:00Z'
  const rows=[['SALE','IN','100.00','CASH'],['CUSTOMER_PAYMENT','IN','50.00','CASH'],['CUSTOMER_PAYMENT_REFUND','OUT','20.00','CASH'],['PHYSICAL_MOVEMENT','OUT','30.00','CASH'],['PHYSICAL_MOVEMENT','IN','40.00','CASH'],['SALE','IN','80.00','BANK']].map(([source_type,direction,amount,settlement_kind],i)=>({id:String(i),source_id:randomUUID(),source_type,direction,amount,settlement_kind,payment_method_id:settlement_kind==='BANK'?2:1,payment_method_name:settlement_kind,currency_code:'GTQ',recorded_at:at,economic_at:at,content_hash:String(i)}))
  const result=summarizeMoneyEvents(rows,{session:{id:randomUUID(),opening_float:'200.00',opening_cash_method_id:1,opening_cash_method_name:'CASH',currency_code:'GTQ'},start:at,end:at})
  assert.equal(result.cash_session.expected_cash_in_drawer,340);assert.equal(result.theoretical.net_total,420)
  assert.equal(result.theoretical.total_sales,180);assert.equal(result.theoretical.total_collections,50);assert.equal(result.theoretical.total_returns,20)
  assert.equal(result.theoretical.total_cash_in,40);assert.equal(result.theoretical.total_cash_out,30)
  assert.equal(result.metrics.total_transactions,2)
})
