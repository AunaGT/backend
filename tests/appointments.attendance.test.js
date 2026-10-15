require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const { transitionBooking, transitionSession } = require('../src/modules/appointments/application')
const id = '00000000-0000-4000-8000-000000000001'
test('cancelar exige razón y estado arbitrario no pasa la frontera', async () => {
  for (const action of ['CANCEL', 'PAID']) await assert.rejects(() => transitionBooking({}, {}, id, { action, reason: '', expectedVersion: 1, idempotencyKey: 'test-12345' }), { status: 400 })
  await assert.rejects(() => transitionSession({}, {}, id, { action: 'CANCEL', reason: '', expectedVersion: 1, idempotencyKey: 'test-12345' }), { status: 400 })
})
