const test = require('node:test')
const assert = require('node:assert/strict')
const { servicesTestDatabaseUrl } = require('./helpers/servicesTestDb.cjs')
test('service migration tests never fall back to application database URLs', () => {
  assert.throws(() => servicesTestDatabaseUrl({ DATABASE_URL: 'postgresql://remote/shared' }), /temporal/i)
  for (const url of ['postgresql://user@remote/auna_services_test', 'postgresql://user@localhost/postgres', 'postgresql://user@localhost/auna_services_test?host=remote', 'https://localhost/auna_services_test']) {
    assert.throws(() => servicesTestDatabaseUrl({ AUNA_SERVICES_TEST_DATABASE_URL: url }))
  }
  assert.equal(servicesTestDatabaseUrl({ AUNA_SERVICES_TEST_DATABASE_URL: 'postgresql://qa@127.0.0.1:6559/auna_services_test' }), 'postgresql://qa@127.0.0.1:6559/auna_services_test')
})

test('explicit staging opt-in permits only the approved existing direct endpoint', () => {
  const url = 'postgresql://qa@aws-1-us-east-2.pooler.supabase.com:5432/postgres'
  assert.equal(new URL(servicesTestDatabaseUrl({ AUNA_SERVICES_STAGING_TESTS: 'approved', DIRECT_URL: url })).hostname, 'aws-1-us-east-2.pooler.supabase.com')
  assert.throws(() => servicesTestDatabaseUrl({ DIRECT_URL: url }))
  assert.throws(() => servicesTestDatabaseUrl({ AUNA_SERVICES_STAGING_TESTS: 'approved', DIRECT_URL: 'postgresql://qa@other/postgres' }))
})
