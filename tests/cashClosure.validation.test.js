const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeClosureNotes,
  requiresDifferenceReason,
} = require('../src/modules/cash-closure/domain')

test('cierre cuadrado no exige motivo', () => {
  assert.equal(requiresDifferenceReason(0, ''), false)
  assert.equal(requiresDifferenceReason(0.004, ''), false)
})

test('faltante o sobrante exige un motivo real', () => {
  assert.equal(requiresDifferenceReason(-10, ''), true)
  assert.equal(requiresDifferenceReason(10, '   '), true)
  assert.equal(requiresDifferenceReason(-10, 'Error al dar cambio'), false)
})

test('normaliza las notas antes de persistir', () => {
  assert.equal(normalizeClosureNotes('  Conteo revisado  '), 'Conteo revisado')
  assert.equal(normalizeClosureNotes(null), '')
})
