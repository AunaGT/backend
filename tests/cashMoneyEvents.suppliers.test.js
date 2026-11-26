const test = require('node:test'), assert = require('node:assert/strict')
const { makePayablesFixture } = require('./helpers/payablesFixture.cjs')
test('omitted or null supplier session preserves historical normalized request hash', () => {
  const { parseSupplierPayment } = require('../src/modules/merchandise/payables/validation'), f = makePayablesFixture()
  assert.deepEqual(parseSupplierPayment({ ...f.input, cashRegisterSessionId: null }), parseSupplierPayment(f.input))
  const linked = parseSupplierPayment({ ...f.input, cashRegisterSessionId: '00000000-0000-4000-8000-000000000001' })
  assert.equal(linked.cashRegisterSessionId, '00000000-0000-4000-8000-000000000001')
  assert.throws(() => parseSupplierPayment({ ...f.input, cashRegisterSessionId: 'invalid' }))
})
