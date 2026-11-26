const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const key = randomUUID(), id = randomUUID(), user = randomUUID()
test('configuration validates commands before touching a database and never accepts coercions or authority fields', () => {
  const { parseRegisterConfiguration } = require('../src/modules/sales/cashRegisters.configuration')
  const input = { requestKey: key, name: ' Caja central ', code: 'central', currencyCode: 'GTQ', authorizedUserIds: [user, user] }
  const value = parseRegisterConfiguration(input)
  assert.equal(value.name, 'Caja central'); assert.equal(value.code, 'CENTRAL'); assert.deepEqual(value.authorizedUserIds, [user])
  for (const patch of [{ name: '' }, { name: 5 }, { code: '' }, { code: 'a/b' }, { requestKey: 'invalid' }, { active: 'false' }, { isDefault: 1 }, { currencyCode: 'quetzales' }, { money_event_version: 1 }, { kind: 'VIRTUAL' }, { action: 'ADOPT' }, { authorizedUserIds: ['another'] }, { enableExplicitAccess: false }]) {
    assert.throws(() => parseRegisterConfiguration({ ...input, ...patch }), e => e.status === 400)
  }
  assert.throws(() => parseRegisterConfiguration({ requestKey: key, id, name: 'Caja' }), e => e.status === 428)
  assert.throws(() => parseRegisterConfiguration({ requestKey: key, id, expectedRevision: 0, name: 'Caja' }), e => e.status === 400)
  assert.throws(() => parseRegisterConfiguration({ requestKey: key, id, expectedRevision: 1, name: 'Caja', code: 'CHANGED' }), e => e.status === 400)
})
test('configuration hashes normalized intent rather than object ordering or freshly generated values', () => {
  const { parseRegisterConfiguration, registerConfigurationHash } = require('../src/modules/sales/cashRegisters.configuration')
  const a = parseRegisterConfiguration({ requestKey: key, id, expectedRevision: 1, name: 'Caja', authorizedUserIds: [user, id] })
  const b = parseRegisterConfiguration({ authorizedUserIds: [id, user], name: 'Caja', expectedRevision: 1, id, requestKey: randomUUID() })
  assert.equal(registerConfigurationHash(a), registerConfigurationHash(b))
  for (const patch of [{ name: 'Otra' }, { authorizedUserIds: [] }, { expectedRevision: 2 }, { id: user }, { active: false }]) assert.notEqual(registerConfigurationHash(a), registerConfigurationHash({ ...a, ...patch }))
})
