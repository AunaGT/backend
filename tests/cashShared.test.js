const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { parseRegisterConfiguration } = require('../src/modules/sales/cashRegisters.configuration')
const { assertSessionOperation } = require('../src/services/cashSessionBoundary')
test('configuration accepts an explicit shared mode and rejects unknown modes', () => {
  const input = { requestKey: randomUUID(), name: 'Equipo', code: 'TEAM', operationMode: 'SHARED' }
  assert.equal(parseRegisterConfiguration(input).operationMode, 'SHARED')
  assert.throws(() => parseRegisterConfiguration({ ...input, operationMode: 'EVERYONE' }), e => e.status === 400)
})
test('only joined shared participants with current access can operate, even for admin', () => {
  const turn = { status: 'OPEN', register_active: true, opened_by_id: 'owner', money_event_version: 1, operation_mode: 'SHARED', register_access_version: 1, register_access_allowed: true, actor_access_allowed: true, actor_participant: true }
  assert.doesNotThrow(() => assertSessionOperation(turn, { userId: 'participant' }))
  assert.throws(() => assertSessionOperation({ ...turn, actor_participant: false }, { userId: 'outsider', isAdmin: true }), e => e.status === 403)
  assert.throws(() => assertSessionOperation({ ...turn, actor_access_allowed: false }, { userId: 'participant' }), e => e.status === 403)
})
test('shared closure breakdown retains exact entries and exits by actor and method', () => {
  const { summarizeMoneyEvents } = require('../src/modules/cash-closure/eventTheoretical')
  const rows = [['a','IN','0.10'],['a','IN','0.20'],['b','OUT','0.10']].map(([actor_id,direction,amount], i) => ({ id: String(i), actor_id, actor_name: actor_id, direction, amount, currency_code: 'GTQ', payment_method_id: 1, payment_method_name: 'Efectivo', settlement_kind: 'CASH', recorded_at: '2026-11-19', content_hash: String(i), source_type: 'PHYSICAL_MOVEMENT' }))
  const data = summarizeMoneyEvents(rows, { session: { id:'s', operation_mode:'SHARED', currency_code:'GTQ' }, start:'2026-11-19', end:'2026-11-19' })
  assert.deepEqual(data.participant_breakdown.map(p => [p.actor_id, p.methods[0].in_amount, p.methods[0].out_amount]), [['a','0.30','0.00'],['b','0.00','0.10']])
})
