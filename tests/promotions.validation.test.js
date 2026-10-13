const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validatePromotionDates, parsePromotionDate } = require('../src/modules/promotions/validation')

test('promotion validity rejects an end date before its start', () => {
  assert.equal(validatePromotionDates('2026-10-10', '2026-10-09'), 'La fecha de fin debe ser posterior o igual a la fecha de inicio')
  assert.equal(validatePromotionDates('2026-10-10', '2026-10-10'), null)
  assert.equal(validatePromotionDates('2026-10-10', null), null)
})

test('promotion validity rejects malformed date input', () => {
  assert.equal(validatePromotionDates('invalid', '2026-10-10'), 'Fecha de inicio no válida')
  assert.equal(validatePromotionDates('2026-10-10', 'invalid'), 'Fecha de fin no válida')
})

test('date-only expiry covers the complete final day in Guatemala', () => {
  assert.equal(parsePromotionDate('2026-10-10', true).toISOString(), '2026-10-11T05:59:59.999Z')
  assert.equal(parsePromotionDate('2026-10-10', false).toISOString(), '2026-10-10T06:00:00.000Z')
})
