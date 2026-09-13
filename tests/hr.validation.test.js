const test = require('node:test')
const assert = require('node:assert/strict')
const { fail, toDate, toMoney, trim, toEnum, toUuid } = require('../src/modules/hr')

test('la API pública de RRHH normaliza valores compartidos con Nómina', () => {
  assert.equal(toMoney('125.555', 'Monto'), 125.56)
  assert.equal(trim('  Empleado  ', 20), 'Empleado')
  assert.equal(toEnum(' mensual ', ['MENSUAL'], 'Frecuencia inválida'), 'MENSUAL')
  assert.equal(
    toUuid('7ca6d4a4-e27c-4e29-a35c-4cf97b31ea59', 'No encontrado'),
    '7ca6d4a4-e27c-4e29-a35c-4cf97b31ea59'
  )
  assert.equal(toDate('2026-09-12', 'Fecha').toISOString(), '2026-09-12T18:00:00.000Z')
})

test('la validación pública conserva status HTTP y mensajes de negocio', () => {
  assert.throws(
    () => fail(409, 'Conflicto'),
    (error) => error.status === 409 && error.message === 'Conflicto'
  )
  assert.throws(() => toMoney(-1, 'Monto'), /mayor o igual a 0/)
  assert.throws(() => toUuid('no-es-uuid', 'Empleado no encontrado'), /Empleado no encontrado/)
})
