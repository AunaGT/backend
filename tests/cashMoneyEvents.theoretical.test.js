const test = require('node:test'), assert = require('node:assert/strict')
const base = { payment_method_id: 1, payment_method_name: 'Efectivo original', settlement_kind: 'CASH', currency_code: 'GTQ', recorded_at: '2026-10-28T12:00:00Z', economic_at: '2026-10-28T12:00:00Z', reference: null, content_hash: 'a'.repeat(64) }
function event(id, type, direction, amount, extra = {}) { return { ...base, id, source_id: id, source_type: type, direction, amount, ...extra } }
test('event theoretical separates real sources, cash float, bank and supplier outflow with exact decimals', () => {
  const { summarizeMoneyEvents } = require('../src/modules/cash-closure/eventTheoretical')
  const session = { id: 's', currency_code: 'GTQ', business_timezone: 'America/Guatemala', opening_float: 200, opening_cash_method_id: 1, opening_cash_method_name: 'Efectivo original' }
  const rows = [event('a', 'SALE', 'IN', '100.00'), event('b', 'CUSTOMER_PAYMENT', 'IN', '50.00'), event('c', 'CUSTOMER_PAYMENT_REFUND', 'OUT', '20.00'),
    event('d', 'CUSTOMER_PAYMENT', 'IN', '80.00', { payment_method_id: 2, payment_method_name: 'Tarjeta', settlement_kind: 'BANK' }), event('e', 'SUPPLIER_PAYMENT', 'OUT', '30.00')]
  const result = summarizeMoneyEvents(rows, { session, start: base.recorded_at, end: '2026-10-29T12:00:00Z' })
  assert.equal(result.theoretical.net_total, 380); assert.equal(result.theoretical.total_sales, 100); assert.equal(result.theoretical.total_collections, 130); assert.equal(result.theoretical.total_returns, 20); assert.equal(result.theoretical.total_supplier_payments, 30)
  assert.equal(result.cash_session.expected_cash_in_drawer, 300); assert.equal(result.event_count, 5); assert.equal(result.calculation_basis, 'EVENTS_V1')
  assert.deepEqual(result.payment_breakdown.map(m => [m.breakdown_key, m.theoretical_amount]), [['1:CASH', 300], ['2:BANK', 80]])
  assert.equal(result.event_hash, summarizeMoneyEvents(rows.toReversed(), { session, start: base.recorded_at, end: '2026-10-29T12:00:00Z' }).event_hash)
})
test('classification changes never merge CASH and BANK under the same method id; zero float retains session identity', () => {
  const { summarizeMoneyEvents } = require('../src/modules/cash-closure/eventTheoretical')
  const result = summarizeMoneyEvents([event('a', 'SALE', 'IN', '0.10'), event('b', 'SALE', 'IN', '0.20', { settlement_kind: 'BANK', payment_method_name: 'Reclassified' })],
    { session: { id: 's', currency_code: 'GTQ', opening_float: 0 }, start: base.recorded_at, end: '2026-10-29T12:00:00Z' })
  assert.equal(result.theoretical.net_total, 0.3); assert.equal(result.cash_session.expected_cash_in_drawer, 0.1)
  assert.equal(result.cash_session.id, 's'); assert.equal(result.payment_breakdown.length, 2)
  assert.deepEqual(result.payment_breakdown.map(m => m.breakdown_key), ['1:CASH', '1:BANK'])
})
test('declarations identify frozen classification slices, not merely mutable method id', () => {
  const { validateDeclaration } = require('../src/modules/cash-closure/declaration')
  const data = { theoretical: { net_total: 30 }, payment_breakdown: [
    { breakdown_key: '1:CASH', payment_method_id: 1, payment_method_name: 'Original', settlement_kind: 'CASH', theoretical_amount: 10, theoretical_count: 1 },
    { breakdown_key: '1:BANK', payment_method_id: 1, payment_method_name: 'Renamed', settlement_kind: 'BANK', theoretical_amount: 20, theoretical_count: 1 }] }
  const body = { actualTotal: 30, paymentBreakdowns: [{ breakdown_key: '1:CASH', payment_method_id: 1, actual_amount: 10 }, { breakdown_key: '1:BANK', payment_method_id: 1, actual_amount: 20 }], denominations: [{ type: 'Billete', denomination: 10, quantity: 1 }] }
  assert.equal(validateDeclaration(body, data).payments.length, 2)
  assert.throws(() => validateDeclaration({ ...body, paymentBreakdowns: body.paymentBreakdowns.map(row => ({ ...row, breakdown_key: '1:CASH' })) }, data), /duplicado/)
})
test('a net bank outflow can be declared exactly without inventing a discrepancy or negative physical cash', () => {
  const { summarizeMoneyEvents } = require('../src/modules/cash-closure/eventTheoretical')
  const { validateDeclaration } = require('../src/modules/cash-closure/declaration')
  const data = summarizeMoneyEvents([event('out', 'SUPPLIER_PAYMENT', 'OUT', '30.00', { settlement_kind: 'BANK', payment_method_name: 'Transferencia' })],
    { session: { id: 's', currency_code: 'GTQ', opening_float: 0 }, start: base.recorded_at, end: '2026-10-29T12:00:00Z' })
  const body = { actualTotal: -30, paymentBreakdowns: [{ breakdown_key: '1:BANK', payment_method_id: 1, actual_amount: '-30.00' }], denominations: [] }
  const declaration = validateDeclaration(body, data)
  assert.equal(declaration.actualTotal, '-30.00'); assert.equal(declaration.difference, '0.00'); assert.equal(declaration.payments[0].difference, '0.00')
  const mixed = summarizeMoneyEvents([event('out', 'SUPPLIER_PAYMENT', 'OUT', '30.00', { settlement_kind: 'BANK' })],
    { session: { id: 's', currency_code: 'GTQ', opening_float: 200, opening_cash_method_id: 1, opening_cash_method_name: 'Efectivo' }, start: base.recorded_at, end: '2026-10-29T12:00:00Z' })
  const mixedBody = { actualTotal: 170, paymentBreakdowns: mixed.payment_breakdown.map(row => ({ ...row, actual_amount: row.theoretical_amount })), denominations: [{ type: 'Billete', denomination: 50, quantity: 4 }] }
  assert.equal(validateDeclaration(mixedBody, mixed).difference, '0.00')
  assert.throws(() => validateDeclaration({ ...mixedBody, paymentBreakdowns: mixedBody.paymentBreakdowns.map(row => row.settlement_kind === 'CASH' ? { ...row, actual_amount: -1 } : row) }, mixed), e => e.status === 400)
  for (const bad of ['-3e1', '-0.001', '-10000000000']) assert.throws(() => validateDeclaration({ ...body, actualTotal: bad }, data), e => e.status === 400)
  const cashData = { ...data, payment_breakdown: [{ ...data.payment_breakdown[0], breakdown_key: '1:CASH', settlement_kind: 'CASH' }] }
  assert.throws(() => validateDeclaration({ ...body, paymentBreakdowns: [{ ...body.paymentBreakdowns[0], breakdown_key: '1:CASH' }] }, cashData), e => e.status === 400)
  assert.throws(() => validateDeclaration({ ...body, denominations: [{ type: 'Billete', denomination: -10, quantity: 3 }] }, data), e => e.status === 400)
})
