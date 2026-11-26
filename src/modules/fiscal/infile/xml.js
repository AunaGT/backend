const { createHash } = require('node:crypto')
const { DOMImplementation, XMLSerializer } = require('@xmldom/xmldom')
const { parseDecimal, lineTotal } = require('../../../services/units/quantity')
const { fail } = require('../errors')
const { contractFor } = require('./contract')
const { canonicalJson } = require('../localPolicy')
const { preflightXml, runIsolatedXml } = require('./validationChild')
const schemas = require('./schemas/manifest.json')
const NS = 'urn:auna:fiscal:local-draft:1'
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const invalid = () => fail(422, 'FISCAL_XML_INPUT_INVALID', 'Revisa los datos congelados del borrador XML local')
function value(text, max = 2000, empty = false) {
  if (typeof text !== 'string' || text.length > max || !empty && !text.trim() || /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text)) throw invalid()
  return text
}
function amount(text, decimals = 2, positive = false) {
  if (typeof text !== 'string') throw invalid()
  try { return parseDecimal(text, { decimals, allowZero: !positive, max: '9999999999.99' }) } catch { throw invalid() }
}

// An Auna working format, deliberately NOT a SAT DTE or a certifiable document.
function buildLocalIssueXml(input) {
  if (!input || input.version !== 1 || input.verification !== 'UNCONFIRMED' || input.externalSendingAllowed !== false || !['LOCAL_SAMPLE', 'CONFIRMATION'].includes(input.source) || input.currency !== 'GTQ') throw invalid()
  if (input.contractId !== contractFor(input.environment).id || input.profile?.policy !== 'LOCAL_DRAFT_LINE_HALF_UP_2' || !['FACT', 'FPEQ'].includes(input.profile?.documentType)) throw invalid()
  const doc = new DOMImplementation().createDocument(NS, 'a:FiscalDraft', null), root = doc.documentElement
  const attribute = (node, name, text) => node.setAttribute(name, value(text, 200))
  const element = function (parent, name, text, empty = false) {
    const node = doc.createElementNS(NS, `a:${name}`); parent.appendChild(node)
    if (arguments.length > 2) node.appendChild(doc.createTextNode(value(text, 8192, empty)))
    return node
  }
  attribute(root, 'Version', '1'); attribute(root, 'Kind', 'ISSUE'); attribute(root, 'Verification', 'UNCONFIRMED'); attribute(root, 'ExternalSendingAllowed', 'false')
  const context = element(root, 'Context')
  for (const key of ['companyId', 'branchId', 'saleId', 'connectorVersionId']) {
    if (!uuid.test(input[key] || '')) throw invalid()
    attribute(context, key, input[key])
  }
  for (const key of ['source', 'contractId', 'environment', 'currency', 'issuedAt']) attribute(context, key, input[key])
  attribute(context, 'RequestedDocumentType', input.profile.documentType)
  attribute(context, 'CalculationPolicy', input.profile.policy)
  const issuer = element(root, 'Issuer')
  for (const key of ['legalName', 'commercialName', 'taxId', 'address', 'municipality', 'department', 'postalCode', 'vatAffiliation']) element(issuer, key[0].toUpperCase() + key.slice(1), input.emitter?.[key], key === 'commercialName')
  const establishment = element(root, 'Establishment')
  if (input.establishment?.branchId !== input.branchId) throw invalid()
  for (const key of ['code', 'name', 'address', 'municipality', 'department', 'postalCode']) element(establishment, key[0].toUpperCase() + key.slice(1), input.establishment[key])
  const receiver = element(root, 'Receiver')
  if (typeof input.receiver?.isFinalConsumer !== 'boolean') throw invalid()
  attribute(receiver, 'IsFinalConsumer', String(input.receiver.isFinalConsumer))
  for (const key of ['name', 'taxId', 'address']) element(receiver, key[0].toUpperCase() + key.slice(1), input.receiver[key], key !== 'name' && input.receiver.isFinalConsumer)
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 500) throw invalid()
  const lines = element(root, 'Lines'), sums = Object.fromEntries(['gross', 'discount', 'taxable', 'tax', 'total'].map(key => [key, amount('0')]))
  for (const [index, row] of input.lines.entries()) {
    const quantity = amount(row.quantity, 6, true), price = amount(row.unitPrice, 18)
    const totals = Object.fromEntries(Object.keys(sums).map(key => [key, amount(row[key])]))
    if (!totals.gross.eq(lineTotal(quantity, price)) || !totals.gross.sub(totals.discount).eq(totals.total) || !totals.taxable.add(totals.tax).eq(totals.total)) throw invalid()
    if (!['GOOD', 'SERVICE'].includes(row.kind) || !uuid.test(row.productId || '')) throw invalid()
    const line = element(lines, 'Line'); attribute(line, 'Number', String(index + 1)); attribute(line, 'Kind', row.kind); attribute(line, 'ProductId', row.productId)
    element(line, 'Name', row.name); element(line, 'SatUnitCode', row.satUnitCode)
    element(line, 'Quantity', row.quantity); element(line, 'UnitPrice', row.unitPrice)
    for (const key of Object.keys(sums)) { element(line, key[0].toUpperCase() + key.slice(1), row[key]); sums[key] = sums[key].add(totals[key]) }
    amount(row.baseQuantity, 6, true); element(line, 'BaseQuantity', row.baseQuantity)
    element(line, 'UnitSnapshot', canonicalJson(row.unitSnapshot))
    const rule = element(line, 'TaxRule')
    for (const key of ['id', 'name', 'mode', 'rate', 'exemptionCode']) element(rule, key[0].toUpperCase() + key.slice(1), row.taxRule?.[key], key === 'exemptionCode')
  }
  const totals = element(root, 'Totals')
  for (const key of Object.keys(sums)) {
    if (!sums[key].eq(amount(input.totals?.[key]))) throw invalid()
    element(totals, key[0].toUpperCase() + key.slice(1), input.totals[key])
  }
  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc, { requireWellFormed: true }), 'utf8')
  preflightXml(xml)
  return xml
}

async function validateAndMatchXml(xml, { kind, input, signal } = {}) {
  if (kind !== 'LOCAL_ISSUE') {
    // No caller-provided path/approval can replace a pinned official bundle.
    if (schemas.status !== 'VERIFIED') throw fail(503, 'FISCAL_SCHEMAS_UNAVAILABLE', 'Faltan los esquemas oficiales verificados; no se validan DTE en esta etapa')
    throw fail(409, 'FISCAL_CONTRACT_UNCONFIRMED', 'El contrato fiscal todavía no está confirmado')
  }
  const expected = buildLocalIssueXml(input)
  preflightXml(xml)
  // Buffer ownership must stay private across awaits: the caller can mutate its copy.
  const bytes = Buffer.from(xml)
  // Both canonicalizations run outside the backend: no untrusted DOM here.
  const deadline = Date.now() + 5000
  const actualCanonical = await runIsolatedXml(bytes, { deadline, signal })
  const expectedCanonical = await runIsolatedXml(expected, { deadline, signal })
  if (!actualCanonical.equals(expectedCanonical)) throw fail(422, 'FISCAL_XML_MISMATCH', 'El XML no coincide con el borrador congelado')
  return Object.freeze({ kind: 'LOCAL_ISSUE', localOnly: true, matched: true, schemaValidated: false, certified: false, externalSendingAllowed: false, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}
module.exports = { buildLocalIssueXml, validateAndMatchXml }
