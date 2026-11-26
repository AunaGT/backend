const test = require('node:test')
const assert = require('node:assert/strict')
const { readKeyring, sealCredentials, openCredentials } = require('../src/modules/fiscal/credentials')
const context = { companyId: '00000000-0000-4000-8000-000000000001', connectorId: '00000000-0000-4000-8000-000000000002', environment: 'TEST', credentialVersion: 1 }
const values = { signUser: ' user-sign ', signKey: ' test-secret-sign ', apiUser: 'user-api', apiKey: 'test-secret-api' }
const keyring = () => readKeyring({ FISCAL_ACTIVE_KEY_ID: 'test-key', FISCAL_ENCRYPTION_KEYS_JSON: JSON.stringify({ 'test-key': Buffer.alloc(32, 7).toString('base64'), 'other-name': Buffer.alloc(32, 7).toString('base64') }) })

test('credentials round-trip without trimming values and encrypt differently on every write', () => {
  const keys = keyring(), a = sealCredentials(context, values, keys), b = sealCredentials(context, values, keys)
  assert.deepEqual(openCredentials(context, a, keys), values)
  assert.notEqual(a.iv, b.iv)
  assert.notEqual(a.ciphertext, b.ciphertext)
  for (const value of Object.values(values)) assert.equal(JSON.stringify(a).includes(value), false)
})

test('maximum-length Unicode credentials also round-trip', () => {
  const unicode = { signUser: '界'.repeat(256), apiUser: '界'.repeat(256), signKey: '界'.repeat(2048), apiKey: '界'.repeat(2048) }
  assert.deepEqual(openCredentials(context, sealCredentials(context, unicode, keyring()), keyring()), unicode)
  const escaped = { signUser: '\ud800'.repeat(256), apiUser: '\ud800'.repeat(256), signKey: '\ud800'.repeat(2048), apiKey: '\ud800'.repeat(2048) }
  assert.deepEqual(openCredentials(context, sealCredentials(context, escaped, keyring()), keyring()), escaped)
})

test('ciphertext cannot be moved to another tenant, connector, environment or version', () => {
  const keys = keyring(), envelope = sealCredentials(context, values, keys)
  for (const change of [{ companyId: '00000000-0000-4000-8000-000000000003' }, { connectorId: '00000000-0000-4000-8000-000000000004' }, { environment: 'PRODUCTION' }, { credentialVersion: 2 }]) {
    assert.throws(() => openCredentials({ ...context, ...change }, envelope, keys), error => error.code === 'FISCAL_CREDENTIALS_UNAVAILABLE')
  }
  for (const change of [{ keyId: 'other-name' }, { ciphertext: Buffer.from('changed').toString('base64') }, { tag: Buffer.alloc(16).toString('base64') }, { iv: Buffer.alloc(12).toString('base64') }]) {
    assert.throws(() => openCredentials(context, { ...envelope, ...change }, keys), error => error.code === 'FISCAL_CREDENTIALS_UNAVAILABLE')
  }
})

test('keyring errors never expose malformed configuration or fall back to plaintext', () => {
  for (const env of [{}, { FISCAL_ACTIVE_KEY_ID: 'x', FISCAL_ENCRYPTION_KEYS_JSON: 'not-json-private' }, { FISCAL_ACTIVE_KEY_ID: 'x', FISCAL_ENCRYPTION_KEYS_JSON: JSON.stringify({ x: 'short-private-key' }) }, { FISCAL_ACTIVE_KEY_ID: 'missing', FISCAL_ENCRYPTION_KEYS_JSON: JSON.stringify({ x: Buffer.alloc(32).toString('base64') }) }]) {
    assert.throws(() => readKeyring(env), error => error.code === 'FISCAL_KEYRING_UNAVAILABLE' && !error.message.includes('private'))
  }
  assert.throws(() => openCredentials(context, sealCredentials(context, values, keyring()), { activeKeyId: 'gone', keys: new Map() }), error => error.code === 'FISCAL_CREDENTIALS_UNAVAILABLE')
})

test('empty, control-containing and unknown credentials are rejected without echoing input', () => {
  for (const change of [{ apiKey: '' }, { signKey: 'private\nvalue' }, { apiUser: ' '.repeat(4) }, { extraSecret: 'private' }, { apiKey: 'x'.repeat(2049) }]) {
    assert.throws(() => sealCredentials(context, { ...values, ...change }, keyring()), error => error.status === 422 && !error.message.includes('private'))
  }
})
