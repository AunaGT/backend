const test = require('node:test'), assert = require('node:assert/strict')
const { DOMParser } = require('@xmldom/xmldom')
const { fixture } = require('./fixtures/fiscal/preparation.cjs')
const { localInput } = require('./fixtures/fiscal/local-input.cjs')
const { contractFor } = require('../src/modules/fiscal/infile/contract')
const xmlModule = () => require('../src/modules/fiscal/infile/xml')
const validationModule = () => require('../src/modules/fiscal/infile/validationChild')
const ns = 'urn:auna:fiscal:local-draft:1'

test('local XML retains exact frozen amounts and deterministic bytes, never masquerades as SAT DTE', () => {
  const input = localInput(), xml = xmlModule().buildLocalIssueXml(input)
  assert.ok(Buffer.isBuffer(xml)); assert.deepEqual(xmlModule().buildLocalIssueXml(input), xml)
  const doc = new DOMParser().parseFromString(xml.toString(), 'application/xml')
  assert.equal(doc.documentElement.namespaceURI, ns)
  assert.equal(doc.documentElement.localName, 'FiscalDraft')
  assert.equal(doc.documentElement.getAttribute('Verification'), 'UNCONFIRMED')
  assert.equal(doc.documentElement.getAttribute('ExternalSendingAllowed'), 'false')
  assert.equal(doc.getElementsByTagNameNS(ns, 'Total')[0].textContent, '112.00')
  assert.equal(doc.getElementsByTagNameNS(ns, 'Tax')[0].textContent, '12.00')
  assert.equal(doc.getElementsByTagNameNS(ns, 'Taxable')[0].textContent, '100.00')
  assert.equal(doc.getElementsByTagNameNS(ns, 'SatUnitCode')[0].textContent, '01')
  assert.equal(doc.getElementsByTagNameNS('http://www.sat.gob.gt/dte/fel/0.2.0', '*').length, 0)
})
test('JSONB property ordering cannot change frozen unit snapshot XML bytes', () => {
  const input = structuredClone(localInput()), reordered = structuredClone(input)
  reordered.lines[0].unitSnapshot = Object.fromEntries(Object.entries(reordered.lines[0].unitSnapshot).reverse())
  reordered.lines[0].unitSnapshot.baseUnit = Object.fromEntries(Object.entries(reordered.lines[0].unitSnapshot.baseUnit).reverse())
  assert.deepEqual(xmlModule().buildLocalIssueXml(reordered), xmlModule().buildLocalIssueXml(input))
})
test('DOM nodes escape markup in names, addresses and attributes without creating elements', () => {
  const f = fixture(), name = 'Bebida <a:Total>0</a:Total> & "especial" Ñ 🥤'
  f.sale.sale_items[0].item_name = name; f.settings.find(r => r.key === 'company_legal_name').value = 'Empresa "A&B"'
  const xml = xmlModule().buildLocalIssueXml(localInput(f)), doc = new DOMParser().parseFromString(xml.toString(), 'application/xml')
  assert.equal(doc.getElementsByTagNameNS(ns, 'Line')[0].getElementsByTagNameNS(ns, 'Name')[0].textContent, name)
  assert.equal(doc.getElementsByTagNameNS(ns, 'LegalName')[0].textContent, 'Empresa "A&B"')
  assert.equal(doc.getElementsByTagNameNS(ns, 'Total').length, 2)
})
test('builder rejects XML controls, unpaired surrogates, unsafe numeric amounts and excessive lines', () => {
  for (const change of [
    input => { input.lines[0].name = 'invalid\u0000text' }, input => { input.receiver.name = '\ud800' },
    input => { input.lines[0].total = 112 }, input => { input.lines[0].total = '111.99' },
    input => { input.lines = Array(501).fill(input.lines[0]) }, input => { input.externalSendingAllowed = true },
    input => { delete input.emitter.legalName }, input => { delete input.receiver.name },
  ]) { const input = structuredClone(localInput()); change(input); assert.throws(() => xmlModule().buildLocalIssueXml(input), error => error.code === 'FISCAL_XML_INPUT_INVALID') }
})
test('preflight rejects external constructs, malformed UTF-8 and limits before launching any parser', () => {
  const bad = [
    Buffer.from('<!DOCTYPE a [<!ENTITY e SYSTEM "file:///tmp/fiscal-canary">]><a>&e;</a>'),
    Buffer.from('<a xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="https://example.invalid/"/></a>'),
    Buffer.from('<a xmlns:x="http://www.w3.org/2001/XMLSchema-instance" x:schemaLocation="urn:a https://example.invalid/schema.xsd"/>'),
    Buffer.from('<a><?fetch file:///tmp/canary?></a>'), Buffer.from([0x3c, 0x61, 0x3e, 0xc3, 0x28]),
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a/>'),
    Buffer.from('<a>'.repeat(65) + '</a>'.repeat(65)), Buffer.from('<a>' + '<b/>'.repeat(50000) + '</a>'),
    Buffer.alloc(2 * 1024 * 1024 + 1, 32), Buffer.from('<a x="unterminated>'),
  ]
  for (const xml of bad) assert.throws(() => validationModule().preflightXml(xml), error => /^FISCAL_XML_/.test(error.code))
  assert.doesNotThrow(() => validationModule().preflightXml(xmlModule().buildLocalIssueXml(localInput())))
})
test('official validation stays unavailable without official schemas even with forged caller approval', async () => {
  for (const contract of [contractFor('TEST'), { verified: true, schemas: { path: '/tmp/arbitrary.xsd' } }]) {
    await assert.rejects(xmlModule().validateAndMatchXml(Buffer.from('<a/>'), { kind: 'ISSUE', input: localInput(), contract }), error => error.code === 'FISCAL_SCHEMAS_UNAVAILABLE')
  }
})
