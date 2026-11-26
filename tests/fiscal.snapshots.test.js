'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { fixture } = require('./fixtures/fiscal/preparation.cjs')
const { buildLocalProfile } = require('../src/modules/fiscal/profiles')
const { prepareFiscalSnapshot } = require('../src/modules/fiscal/snapshots')
function prepare(f, change = {}) {
  const version = { id: f.ids.version, company_id: f.ids.company, connector_id: f.ids.connector, environment: 'TEST', contract_id: 'infile-unified-offline-v1', number: 1, profile: buildLocalProfile(f.draft, f.settings) }
  return prepareFiscalSnapshot(f.scope, f.sale, { connectorVersion: version, products: f.products, source: 'LOCAL_SAMPLE', issuedAt: '2026-10-23T10:00:00-06:00', renderProfiles: { LETTER: { versionId: 'synthetic-layout' } }, ...change })
}
test('112 fixture with explicit included .12 yields exact 100 base and 12 tax', () => {
  const result = prepare(fixture())
  assert.deepEqual(result.totals, { gross: '112.00', discount: '0.00', taxable: '100.00', tax: '12.00', total: '112.00' })
  assert.equal(result.lines[0].satUnitCode, '01'); assert.equal(result.lines[0].kind, 'GOOD')
  assert.equal(result.verification, 'UNCONFIRMED'); assert.equal(result.externalSendingAllowed, false)
  assert.equal(result.issuedAt, '2026-10-23T10:00:00-06:00')
  assert.equal(result.currency, 'GTQ')
})
test('POS nullable discount means no discount, not missing fiscal money', () => {
  const f = fixture(); f.sale.discount_total = null
  assert.equal(prepare(f).totals.discount, '0.00')
  f.sale.total = '111.00'; f.sale.sale_items[0].net_total = '111.00'
  assert.throws(() => prepare(f), error => !!error.fields?.totals)
})
test('new v1 confirmation uses persisted label, precision and quantity without catalog conversion', () => {
  const f = fixture(), line = f.sale.sale_items[0]
  f.sale.unit_metadata_version = 1
  Object.assign(line, { unit_metadata_version: 1, unit_snapshot: null, base_qty: null, unit_label: 'hora', quantity_decimals: 2, item_kind: 'SERVICE' })
  const result = prepare(f, { source: 'CONFIRMATION' })
  assert.equal(result.lines[0].satUnitCode, '02')
  assert.equal(result.lines[0].baseQuantity, '1')
  assert.deepEqual(result.lines[0].unitSnapshot, { version: 1, unit_label: 'hora', quantity_decimals: 2, factor: '1' })
  assert.throws(() => prepare(f, { source: 'LEGACY' }), error => error.code === 'FISCAL_LEGACY_REVIEW_REQUIRED')
  line.unit_label = null
  assert.throws(() => prepare(f, { source: 'CONFIRMATION' }), error => !!error.fields?.['lines.0.unit'])
})
test('fractions, frozen presentation versions and discounted net totals retain commercial sums', () => {
  const f = fixture(), line = f.sale.sale_items[0]
  line.qty = '0.5'; line.price = '224'; line.net_total = '100.80'; line.quantity_decimals = 2; line.base_qty = '5'
  line.unit_snapshot.presentation = { id: f.ids.presentation, version: 2, name: 'Caja', label: 'cj', decimals: 2 }; line.unit_snapshot.factor = '10'
  f.sale.discount_total = '11.20'; f.sale.total = '100.80'
  const result = prepare(f)
  assert.deepEqual(result.totals, { gross: '112.00', discount: '11.20', taxable: '90.00', tax: '10.80', total: '100.80' })
  assert.equal(result.lines[0].satUnitCode, '03'); assert.equal(result.lines[0].quantity, '0.5')
  assert.equal(result.lines[0].unitSnapshot.presentation.version, 2)
  assert.equal(result.lines[0].baseQuantity, '5')
})
test('explicit legacy-unit mapping and service kind work without inferring names', () => {
  const f = fixture(), line = f.sale.sale_items[0]
  line.unit_metadata_version = 1; line.unit_snapshot = { version: 1, factor: '1', unit_label: 'hora' }; line.item_kind = 'SERVICE'
  const result = prepare(f)
  assert.equal(result.lines[0].satUnitCode, '02'); assert.equal(result.lines[0].kind, 'SERVICE')
})
test('exempt and no-breakdown fixtures never inherit an included tax rate', () => {
  for (const mode of ['EXEMPT', 'NO_BREAKDOWN']) {
    const f = fixture(); f.draft.taxRules[0] = { ...f.draft.taxRules[0], mode, rate: '0', exemptionCode: mode === 'EXEMPT' ? 'fixture-exemption' : '' }
    if (mode === 'NO_BREAKDOWN') { f.draft.documentType = 'FPEQ'; f.settings.find(r => r.key === 'vat_affiliation').value = 'pequeno_contribuyente' }
    assert.deepEqual(prepare(f).totals, { gross: '112.00', discount: '0.00', taxable: '112.00', tax: '0.00', total: '112.00' })
  }
})
test('unmapped units, credit, unknown currency, mismatched totals and incomplete receivers block', () => {
  for (const alter of [
    f => { f.draft.unitMap = [] }, f => { f.draft.categoryTaxMap = [] }, f => { f.sale.payment_status = 'PENDING' },
    f => { f.settings.find(r => r.key === 'currency_code').value = 'USD' },
    f => { f.sale.total = '111.99' }, f => { f.sale.sale_items[0].net_total = null },
    f => { f.sale.is_final_consumer = false; f.sale.customer_nit = '' },
    f => { f.sale.is_final_consumer = false; f.sale.customer_nit = 'TEST-NIT' },
    f => { f.sale.sale_items[0].price = 112 }, f => { f.sale.branch.company_id = f.ids.actor },
    f => { f.sale.branch_id = f.ids.actor },
  ]) { const f = fixture(); alter(f); assert.throws(() => prepare(f), error => error.code?.startsWith('FISCAL_')) }
})
test('snapshot is detached and frozen, and legacy reads cannot rebuild history with current data', () => {
  const f = fixture(), result = prepare(f)
  f.sale.sale_items[0].item_name = 'Changed'; f.settings[0].value = 'Changed'; f.draft.taxRules[0].rate = '0.5'; f.products[0].price = '1'
  f.settings.find(row => row.key === 'iva_rate').value = '50'
  assert.equal(result.lines[0].name, 'Producto de prueba'); assert.equal(result.emitter.legalName, 'Emisor ficticio, S.A.')
  assert.throws(() => { result.totals.total = '1' }, TypeError)
  f.sale.fiscal_snapshot = result
  assert.deepEqual(prepare(f), result)
  assert.throws(() => prepare(f, { source: 'LEGACY' }), error => error.code === 'FISCAL_LEGACY_REVIEW_REQUIRED')
  delete f.sale.fiscal_snapshot
  assert.throws(() => prepare(f, { issuedAt: '2026-02-30T10:00:00-06:00' }), error => error.code?.startsWith('FISCAL_'))
})
