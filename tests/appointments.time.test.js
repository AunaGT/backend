const test = require('node:test'), assert = require('node:assert/strict')
const { resolveLocal } = require('../src/modules/appointments/domain/time')
test('DST no desplaza horas inexistentes ni elige una ambigua', () => {
  assert.throws(() => resolveLocal('2026-03-08T02:30', 'America/New_York'), /no existe/i)
  assert.throws(() => resolveLocal('2026-11-01T01:30', 'America/New_York'), /ambigua/i)
  assert.equal(resolveLocal('2026-10-12T09:00', 'America/Guatemala'), '2026-10-12T15:00:00.000Z')
  assert.equal(resolveLocal('2026-11-01T01:30', 'America/New_York', -240), '2026-11-01T05:30:00.000Z')
  assert.equal(resolveLocal('2026-11-01T01:30', 'America/New_York', -300), '2026-11-01T06:30:00.000Z')
})
