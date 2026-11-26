const test = require('node:test'), assert = require('node:assert/strict')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { companyId: uuid(1), branchId: uuid(2), userId: uuid(3), isAdmin: false }
function fixture() {
  const events = []
  const session = { id: uuid(4), cash_register_id: uuid(5), money_event_version: 1, status: 'OPEN',
    register_active: true, register_kind: 'PHYSICAL', register_type: 'PHYSICAL', opened_by_id: scope.userId,
    branch_id: scope.branchId, company_id: scope.companyId, currency_code: 'GTQ' }
  const source = { company_id: scope.companyId, branch_id: scope.branchId, session_id: session.id, actor_id: scope.userId,
    method_id: 1, amount: '100.00', economic_at: new Date('2026-10-28T12:00:00Z'), reference: 'V-001', direction: 'IN', eligible: true }
  const method = { id: 1, name: 'Efectivo', is_credit: false, settlement_kind: 'CASH', company_id: scope.companyId }
  const tx = { $executeRaw: async () => 1,
    companyPaymentMethod: { findFirst: async () => ({ enabled: true, payment_method: method }) },
    systemSetting: { findUnique: async () => ({ value: 'GTQ' }) },
    $queryRaw: async (sql, ...values) => {
      const query = String(sql)
      if (query.includes('cash_money_source(')) return [{ ...source }]
      if (query.includes('INSERT INTO cash_money_events')) {
        const row = JSON.parse(values.find(v => typeof v === 'string' && v.startsWith('{')))
        if (events.some(e => e.source_type === row.source_type && e.source_id === row.source_id)) return []
        events.push(row); return [row]
      }
      if (query.includes('FROM cash_money_events')) return events.filter(e => e.source_type === 'SALE' && e.source_id === uuid(6))
      assert.fail('Unexpected event query: ' + query)
    } }
  const run = () => require('../src/modules/cash-closure/events').recordMoneyEvent(tx, scope, { session, sourceType: 'SALE', sourceId: uuid(6) })
  return { run, events, session, source, method, tx }
}
test('money event records persisted source values once, not request totals', async () => {
  const f = fixture(), first = await f.run(), second = await f.run()
  assert.equal(first.id, second.id); assert.equal(second.replayed, true)
  assert.equal(f.events.length, 1); assert.equal(f.events[0].amount, '100.00')
  assert.equal(f.events[0].actor_id, scope.userId); assert.equal(f.events[0].currency_code, 'GTQ')
  assert.equal(f.events[0].settlement_kind, 'CASH'); assert.equal(f.events[0].direction, 'IN')
})
test('existing event keeps method name/classification and replays even after closing', async () => {
  const f = fixture(); const original = await f.run()
  f.method.name = 'Nombre nuevo'; f.method.settlement_kind = 'BANK'; f.session.status = 'CLOSED'
  assert.equal((await f.run()).id, original.id)
  assert.equal(f.events[0].payment_method_name, 'Efectivo'); assert.equal(f.events[0].settlement_kind, 'CASH')
})
test('same source with changed money or destination conflicts without altering the event', async () => {
  const f = fixture(); await f.run(); f.source.amount = '101.00'
  await assert.rejects(f.run(), e => e.code === 'CASH_EVENT_CONFLICT' && e.status === 409)
  assert.equal(f.events[0].amount, '100.00'); assert.equal(f.events.length, 1)
})
test('foreign source or actor is never recorded or disclosed', async () => {
  for (const patch of [{ company_id: uuid(8) }, { branch_id: uuid(8) }, { actor_id: uuid(8) }, { session_id: uuid(8) }, { valid_scope: false }]) {
    const f = fixture(); Object.assign(f.source, patch)
    await assert.rejects(f.run(), e => e.status === 404)
    assert.equal(f.events.length, 0)
  }
})
test('a recorded source cannot change its own currency on replay', async () => {
  const f = fixture(); f.source.currency_code = 'GTQ'; await f.run(); f.source.currency_code = 'USD'
  await assert.rejects(f.run(), e => e.code === 'CASH_EVENT_CONFLICT'); assert.equal(f.events[0].currency_code, 'GTQ')
})
test('legacy turn, credit-only source and legitimate zero sale produce no money event', async () => {
  const f = fixture(); f.session.money_event_version = 0
  f.tx.$queryRaw = async () => assert.fail('Legacy must not query the additive ledger')
  assert.equal(await f.run(), null)
  for (const patch of [{ eligible: false }, { amount: '0.00' }]) {
    const g = fixture(); Object.assign(g.source, patch); assert.equal(await g.run(), null); assert.equal(g.events.length, 0)
  }
})
test('new events reject invalid amount, unknown classification, mismatched currency and closed turn', async () => {
  for (const amount of ['-1', '1.001', '1e2', 'NaN', '10000000000.00']) {
    const f = fixture(); f.source.amount = amount
    await assert.rejects(f.run(), e => e.status === 400); assert.equal(f.events.length, 0)
  }
  const cases = [f => { f.method.settlement_kind = null }, f => { f.session.currency_code = 'USD' }, f => { f.session.status = 'CLOSED' }]
  for (const alter of cases) { const f = fixture(); alter(f); await assert.rejects(f.run(), e => e.status === 409); assert.equal(f.events.length, 0) }
})
