require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const { joinWaitlist, withdrawWaitlist } = require('../src/modules/appointments/application')
const id = '00000000-0000-4000-8000-000000000001'
test('espera no acepta sobreescribir prioridad ni retirar sin razón', async () => {
  await assert.rejects(() => joinWaitlist({}, {}, id, { contactId: id, idempotencyKey: 'test-12345', priority: 1 }), { status: 400 })
  await assert.rejects(() => withdrawWaitlist({}, {}, id, { reason: '', idempotencyKey: 'test-12345' }), { status: 400 })
})
