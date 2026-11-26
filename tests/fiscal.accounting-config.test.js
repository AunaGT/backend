const test = require('node:test'), assert = require('node:assert/strict')
const { fixture } = require('./fixtures/fiscal/preparation.cjs')
const { buildLocalProfile, issuerFromSettings, profileIssues } = require('../src/modules/fiscal/profiles')
const settingsFor = (overrides = {}) => {
  const f = fixture()
  const values = { ...Object.fromEntries(f.settings.map(row => [row.key, row.value])), iva_rate: '12', pequeno_rate: '5', ...overrides }
  return Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value, revision: 1 }))
}
test('fiscal preparation freezes the same company rates used by accounting without adding small-business liability to an invoice', async () => {
  const { draft } = fixture(), settings = settingsFor()
  const profile = buildLocalProfile(draft, settings)
  assert.equal(profile.taxConfiguration.source, 'COMPANY_SETTINGS')
  assert.equal(profile.taxConfiguration.ivaRate, '0.12')
  assert.equal(profile.taxConfiguration.pequenoRate, '0.05')
  const { getTaxConfig } = require('../src/services/accounting/core')
  const accounting = await getTaxConfig({ systemSetting: { findMany: async ({ where }) => { assert.equal(where.company_id, 'company'); return settings } } }, 'company')
  assert.deepEqual(accounting, { regime: 'GENERAL', ivaRate: 0.12, pequenoRate: 0.05 })
  const small = buildLocalProfile({ ...draft, documentType: 'FPEQ', taxRules: [{ ...draft.taxRules[0], mode: 'NO_BREAKDOWN', rate: '0' }] }, settingsFor({ vat_affiliation: 'pequeno_contribuyente' }))
  assert.equal(small.taxRules[0].rate, '0')
  assert.equal(small.taxConfiguration.pequenoRate, '0.05')
  assert.deepEqual(profileIssues(small), {})
})
test('rates and their revisions invalidate an observed fiscal configuration, including an A-B-A edit', () => {
  const rows = settingsFor(), first = issuerFromSettings(rows)
  assert.notEqual(issuerFromSettings(settingsFor({ iva_rate: '10' })).settingsFingerprint, first.settingsFingerprint)
  assert.notEqual(issuerFromSettings(rows.map(row => row.key === 'iva_rate' ? { ...row, revision: 3 } : row)).settingsFingerprint, first.settingsFingerprint)
  assert.equal(issuerFromSettings([...rows].reverse()).settingsFingerprint, first.settingsFingerprint)
  const profile = buildLocalProfile(fixture().draft, rows)
  rows.find(row => row.key === 'iva_rate').value = '10'
  assert.equal(profile.taxConfiguration.ivaRate, '0.12')
})
test('missing or malformed company rates never become implicit FEL defaults', () => {
  for (const value of [undefined, '', ' ', 'NaN', '-1', '100', '1e1', '12abc', '0.00001']) {
    const context = issuerFromSettings(settingsFor({ iva_rate: value }))
    assert.equal(context.taxConfiguration.ivaRate, null, String(value))
    assert.ok(context.taxConfiguration.issues.iva_rate, String(value))
    assert.throws(() => buildLocalProfile(fixture().draft, settingsFor({ iva_rate: value })), error => error.code === 'FISCAL_PROFILE_INVALID')
  }
  const zero = issuerFromSettings(settingsFor({ iva_rate: '0' }))
  assert.equal(zero.taxConfiguration.ivaRate, '0')
  assert.throws(() => buildLocalProfile(fixture().draft, settingsFor({ iva_rate: '0' })), error => error.code === 'FISCAL_PROFILE_INVALID')
})
test('independent rates or a regime-incompatible treatment cannot be saved as an aligned fiscal profile', () => {
  const { draft } = fixture()
  assert.throws(() => buildLocalProfile({ ...draft, taxRules: [{ ...draft.taxRules[0], rate: '0.1' }] }, settingsFor()), error => !!error.fields?.['taxRules.0.rate'])
  assert.throws(() => buildLocalProfile(draft, settingsFor({ vat_affiliation: 'pequeno_contribuyente' })), error => error.code === 'FISCAL_PROFILE_INVALID')
  assert.throws(() => buildLocalProfile({ ...draft, taxRules: [{ ...draft.taxRules[0], mode: 'NO_BREAKDOWN', rate: '0' }] }, settingsFor()), error => error.code === 'FISCAL_PROFILE_INVALID')
  const legacy = buildLocalProfile(draft, settingsFor()); delete legacy.taxConfiguration
  assert.ok(profileIssues(legacy).taxConfiguration)
})
test('accounting keeps its legacy fallbacks without relaxing strict fiscal preparation', async () => {
  const { getTaxConfig } = require('../src/services/accounting/core')
  for (const [rows, want] of [
    [[], { regime: 'GENERAL', ivaRate: .12, pequenoRate: .05 }],
    [settingsFor({ vat_affiliation: 'PEQUEÑO', iva_rate: 'invalid', pequeno_rate: '0' }), { regime: 'PEQUENO', ivaRate: .12, pequenoRate: 0 }],
    [settingsFor({ iva_rate: '7.125', pequeno_rate: '3.45' }), { regime: 'GENERAL', ivaRate: .07125, pequenoRate: .0345 }],
  ]) assert.deepEqual(await getTaxConfig({ systemSetting: { findMany: async () => rows } }, 'company'), want)
})
test('saved fiscal rates remain immutable on read; current accounting rates and exemption limitations are explicit', async () => {
  const f = fixture(), saved = buildLocalProfile(f.draft, settingsFor())
  saved.taxRules[0] = { ...saved.taxRules[0], mode: 'EXEMPT', rate: '0', exemptionCode: 'unconfirmed-fixture' }
  const { readFiscalProfile } = require('../src/modules/fiscal/connectorService')
  const db = {
    fiscalConnector: { findFirst: async ({ where }) => { assert.equal(where.company_id, f.ids.company); return { id: f.ids.connector, revision: 2, versions: [{ id: f.ids.version, profile: saved, establishments: saved.establishments.map(data => ({ data })) }] } } },
    systemSetting: { findMany: async ({ where }) => { assert.equal(where.company_id, f.ids.company); assert.ok(where.key.in.includes('iva_rate')); return settingsFor({ iva_rate: '10' }) } },
  }
  for (const model of ['branch', 'productCategory', 'product', 'measureUnit', 'productPresentation']) db[model] = { findMany: async ({ where }) => where.id.in.map(id => ({ id, name: 'Fixture' })) }
  const result = await readFiscalProfile(db, f.scope, 'TEST')
  assert.equal(result.profile.taxConfiguration.ivaRate, '0.12')
  assert.equal(result.currentIssuer.taxConfiguration.ivaRate, '0.1')
  assert.ok(result.readiness.fieldErrors['emitter.changed'])
  assert.ok(result.readiness.fieldErrors['taxConfiguration.accountingAlignment'])
  assert.equal(result.readiness.valid, false)
})
test('all settings entry points reject rates that strict fiscal preparation cannot represent', async () => {
  const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
  const model = require.resolve('../src/models/prisma'), target = require.resolve('../src/modules/config/controller')
  const db = { $transaction: async () => [], systemSetting: { findMany: async () => [] } }
  await withMocks({ [model]: { prisma: db, prismaTransaction: db } }, target, async controller => {
    for (const key of ['iva_rate', 'pequeno_rate']) for (const value of [null, true, false, '', ' ', '1e1', '0.00001', {}, '100', '-1']) {
      const res = jsonResponse()
      await controller.update({ companyId: 'company', body: { [key]: value, expectedRevisions: { [key]: 0 } } }, res, e => { throw e })
      assert.equal(res.statusCode, 400, `${key} ${JSON.stringify(value)}`)
    }
  })
})
