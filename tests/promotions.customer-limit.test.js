const { test } = require('node:test')
const assert = require('node:assert/strict')
const { customerLimitError } = require('../src/modules/promotions/customerLimit')

test('a per-customer limit requires an identified customer', () => {
  assert.equal(customerLimitError(1, null, 0), 'Esta promoción requiere seleccionar un cliente')
  assert.equal(customerLimitError(null, null, 0), null)
})

test('a customer cannot exceed the configured number of uses', () => {
  assert.equal(customerLimitError(1, 'customer-1', 1), 'Este cliente alcanzó el límite de usos de la promoción')
  assert.equal(customerLimitError(2, 'customer-1', 1), null)
})
