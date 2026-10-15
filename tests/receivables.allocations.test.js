const test = require('node:test')
const assert = require('node:assert/strict')
let rules = {}
try { rules = require('../src/modules/receivables/domain/paymentAllocations') } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }
test('a receipt keeps each cent in one destination and reserves advances', () => {
  assert.equal(typeof rules.receiptAllocation, 'function')
  assert.deepEqual(rules.receiptAllocation({ received:'100.00',applied:'30.00',committed:'60.00',refunded:'5.00' }),
    { received:'100.00',applied:'30.00',committed:'60.00',refunded:'5.00',available:'5.00' })
  assert.equal(rules.receiptAllocation({received:'0.30',applied:'0.10',committed:'0.20',refunded:'0.00'}).available,'0.00')
})
test('over-allocation, invalid money and silently rounded fractions are rejected', () => {
  assert.equal(typeof rules.receiptAllocation, 'function')
  assert.throws(() => rules.receiptAllocation({received:'0.30',applied:'0.10',committed:'0.21',refunded:'0.00'}),{code:'PAYMENT_ALLOCATION_CONFLICT'})
  for (const value of ['-1','0.001','NaN','Infinity','1e2','10000000000.00','',null,{},true]) {
    assert.throws(() => rules.receiptAllocation({received:value,applied:'0',committed:'0',refunded:'0'}),{code:'INVALID_MONEY'})
  }
})
