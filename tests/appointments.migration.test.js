const test = require('node:test'), assert = require('node:assert/strict')
const { appointmentsTestUrl } = require('./helpers/appointmentsTestDb.cjs')
test('ensayo rechaza base remota o implícita antes de abrir conexiones', () => {
  for (const env of [{}, { APPOINTMENTS_TEST_DATABASE_URL: 'postgresql://qa@staging.example.invalid/db' }, { APPOINTMENTS_TEST_DATABASE_URL: 'https://localhost/database' }]) assert.throws(() => appointmentsTestUrl(env))
  assert.equal(new URL(appointmentsTestUrl({ APPOINTMENTS_TEST_DATABASE_URL: 'postgresql://qa@127.0.0.1:55487/postgres?schema=public' })).searchParams.has('schema'), false)
})
