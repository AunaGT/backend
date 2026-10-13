const test = require('node:test')
const assert = require('node:assert/strict')
const { formatAlertTimestamp } = require('../src/modules/alerts/presentation')

test('la fecha de alerta respeta el día local de Guatemala sin perder el formato anterior', () => {
  const result = formatAlertTimestamp(new Date('2026-09-28T03:30:00.000Z'))
  assert.equal(result.localDate, '2026-09-27')
  assert.match(result.timestamp, /^27 .* 2026 21:30$/)
  assert.equal(result.timestampIso, '2026-09-28T03:30:00.000Z')
})
