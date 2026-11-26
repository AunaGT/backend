const test = require('node:test'), assert = require('node:assert/strict')

test('proposed action URLs are optional, canonical and do not change the offline contract', () => {
  const { normalizeEndpoints } = require('../src/modules/fiscal/endpoints')
  assert.deepEqual(normalizeEndpoints({ ISSUE: 'https://Provider.example.invalid:443/issue', CANCEL: null }), { ISSUE: 'https://provider.example.invalid/issue', CANCEL: null })
  const { contractFor, assertExternalSendingAllowed } = require('../src/modules/fiscal/infile/contract')
  const configured = { endpoints: { ISSUE: 'https://provider.example.invalid/issue' }, approved: true }
  assert.equal(contractFor('PRODUCTION', configured).endpoint, null)
  assert.throws(() => assertExternalSendingAllowed(configured), error => error.code === 'FISCAL_EXTERNAL_DISABLED')
})
test('proposed URLs reject secret-bearing, local or malformed destinations without any network lookup', () => {
  const { normalizeEndpoints } = require('../src/modules/fiscal/endpoints')
  for (const value of ['http://provider.example.invalid/issue', 'https://user:synthetic-secret@provider.example.invalid/issue', 'https://provider.example.invalid/issue?token=synthetic-secret', 'https://provider.example.invalid/#synthetic-secret', 'https://localhost/issue', 'https://127.0.0.1/issue', 'https://[::1]/issue', 'https://2130706433/issue', 'https://metadata.google.internal/issue', 'https://service.local/issue', ' https://provider.example.invalid/issue', 'https://provider.example.invalid/\nissue', 'https://provider.example.invalid:444/issue', '', 1]) {
    assert.throws(() => normalizeEndpoints({ ISSUE: value }), error => error.code === 'FISCAL_ENDPOINT_INVALID' && !!error.fields['endpoints.ISSUE'] && !error.message.includes('synthetic-secret'))
  }
  for (const value of [{}, [], { ISSUE: undefined }, { APPROVE: 'https://provider.example.invalid/' }]) assert.throws(() => normalizeEndpoints(value), error => error.code === 'FISCAL_ENDPOINT_INVALID')
})
