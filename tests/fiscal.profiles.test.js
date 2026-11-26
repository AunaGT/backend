const test = require('node:test'), assert = require('node:assert/strict')
const { fixture } = require('./fixtures/fiscal/preparation.cjs')
const { normalizeProfileDraft, buildLocalProfile, profileIssues } = require('../src/modules/fiscal/profiles')
test('explicit local profile preserves codes and never turns a draft into provider approval', () => {
  const { draft, settings } = fixture(), profile = buildLocalProfile(draft, settings)
  assert.equal(profile.establishments[0].code, '001'); assert.equal(profile.unitMap[0].satCode, '01')
  assert.equal(profile.verification, 'UNCONFIRMED'); assert.equal(profile.policy, 'LOCAL_DRAFT_LINE_HALF_UP_2')
  assert.deepEqual(profileIssues(profile), {})
  assert.equal(profile.emitter.legalName, 'Emisor ficticio, S.A.')
  assert.equal(profile.emitter.taxId, 'TEST-NIT')
})
test('incomplete issuer or mappings return concrete missing fields rather than defaults', () => {
  const profile = buildLocalProfile({ documentType: '', taxRules: [], unitMap: [], productTaxMap: [], categoryTaxMap: [], establishments: [] }, [])
  const errors = profileIssues(profile)
  for (const field of ['emitter.legalName', 'emitter.taxId', 'emitter.vatAffiliation', 'currency', 'documentType', 'establishments', 'taxRules', 'unitMap']) assert.ok(errors[field], field)
  assert.equal(profile.currency, ''); assert.equal(profile.documentType, '')
  const f = fixture(), unmapped = buildLocalProfile({ ...f.draft, categoryTaxMap: [], productTaxMap: [] }, f.settings)
  assert.ok(profileIssues(unmapped).taxMappings)
})
test('profile validates duplicates, unsupported taxes, IDs, rates and a bounded payload', () => {
  const { draft } = fixture()
  for (const input of [
    { ...draft, verified: true }, { ...draft, taxRules: [{ ...draft.taxRules[0], mode: 'SPECIFIC' }] },
    { ...draft, taxRules: [{ ...draft.taxRules[0], rate: 0.12 }] },
    { ...draft, unitMap: [draft.unitMap[0], draft.unitMap[0]] },
    { ...draft, productTaxMap: [{ productId: 'invalid', taxRuleId: 'local-included' }] },
    { ...draft, categoryTaxMap: [{ categoryId: 10, taxRuleId: 'unknown' }] },
    { ...draft, taxRules: [{ ...draft.taxRules[0], rate: '1.01' }] },
    { ...draft, establishments: [{ ...draft.establishments[0], name: 'x'.repeat(140000) }] },
  ]) assert.throws(() => normalizeProfileDraft(input), error => error.status === 422 || error.status === 413)
})
