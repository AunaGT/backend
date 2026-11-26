const { DateTime } = require('luxon')
const { Prisma } = require('@prisma/client')
const { parseDecimal, lineTotal } = require('../../services/units/quantity')
const { authorize } = require('./permissions')
const { fail } = require('./errors')
const { profileIssues } = require('./profiles')
const { contractFor } = require('./infile/contract')
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
function blocked(field, message = 'Revisa este dato antes de preparar el documento', code = 'FISCAL_INPUT_INCOMPLETE') { throw fail(422, code, 'No se pudo preparar el documento fiscal local', { [field]: message }) }
function decimal(value, field, decimals = 2, positive = false) {
  if (typeof value !== 'string' && !Prisma.Decimal.isDecimal(value)) blocked(field, 'El importe o cantidad debe conservar su valor decimal exacto.')
  try { return parseDecimal(value, { decimals, allowZero: !positive, max: '9999999999.99' }) } catch { blocked(field) }
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
// Internal preparation only: confirmation/queue callers will integrate in Task 5.
// No database writes, provider traffic or historical reconstruction happens here.
function prepareFiscalSnapshot(scope, sale, options) {
  const s = authorize(scope), version = options?.connectorVersion
  if (!uuid.test(s.branchId || '') || !uuid.test(sale?.id || '') || sale.branch_id !== s.branchId || sale.branch?.company_id !== s.companyId) throw fail(404, 'FISCAL_SOURCE_NOT_FOUND', 'No se encontró el origen fiscal en esta empresa y sucursal')
  if (!['LOCAL_SAMPLE', 'CONFIRMATION'].includes(options?.source)) throw fail(409, 'FISCAL_LEGACY_REVIEW_REQUIRED', 'El histórico requiere revisión fiscal; no se reconstruye con los datos actuales')
  if (sale.fiscal_snapshot) {
    const saved = sale.fiscal_snapshot
    if (saved.companyId !== s.companyId || saved.branchId !== s.branchId || saved.saleId !== sale.id || saved.version !== 1 || saved.externalSendingAllowed !== false) blocked('snapshot')
    return freeze(structuredClone(saved))
  }
  if (!version || version.company_id !== s.companyId || !uuid.test(version.id || '') || !uuid.test(version.connector_id || '')) blocked('connectorVersion')
  contractFor(version.environment)
  const profile = version.profile, errors = profileIssues(profile)
  if (Object.keys(errors).length) throw fail(422, 'FISCAL_PROFILE_INCOMPLETE', 'Completa los datos fiscales del borrador', errors)
  if (profile.verification !== 'UNCONFIRMED' || profile.policy !== 'LOCAL_DRAFT_LINE_HALF_UP_2') blocked('profile', 'La política de cálculo local no está reconocida.')
  const establishment = profile.establishments.find(row => row.branchId === s.branchId)
  if (!establishment) blocked('establishment', 'Falta configurar el establecimiento de esta sucursal.')
  const issuedAt = options.issuedAt
  if (typeof issuedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-06:00$/.test(issuedAt) || !DateTime.fromISO(issuedAt, { setZone: true }).isValid) blocked('issuedAt', 'Fija una fecha válida con el desfase de Guatemala.')
  if (sale.payment_status !== 'PAID') blocked('paymentPolicy', 'El tratamiento fiscal de crédito está pendiente de confirmar.')
  if (typeof sale.is_final_consumer !== 'boolean') blocked('receiver.isFinalConsumer')
  const receiver = { isFinalConsumer: sale.is_final_consumer, name: sale.customer || '', taxId: sale.customer_nit || '', address: options.receiver?.address || '' }
  if (!receiver.name || !receiver.isFinalConsumer && !receiver.taxId || receiver.isFinalConsumer && receiver.taxId && receiver.taxId !== 'CF') blocked('receiver', 'Revisa nombre, NIT y condición de consumidor final.')
  if (typeof receiver.address !== 'string' || receiver.address.length > 500 || !receiver.isFinalConsumer && !receiver.address.trim()) blocked('receiver.address', 'Completa la dirección del receptor para esta preparación local.')
  if (options.receiver && ['name', 'taxId', 'isFinalConsumer'].some(key => Object.hasOwn(options.receiver, key) && options.receiver[key] !== receiver[key])) blocked('receiver', 'El receptor no coincide con la venta congelada.')
  if (!Array.isArray(sale.sale_items) || !sale.sale_items.length || sale.sale_items.length > 500) blocked('lines')
  const products = new Map((options.products || []).map(row => [row.id, row]))
  let grossSum = decimal('0', 'total'), discountSum = grossSum, taxableSum = grossSum, taxSum = grossSum, netSum = grossSum
  const lines = sale.sale_items.map((row, index) => {
    const field = `lines.${index}`, product = products.get(row.product_id)
    if (!product || product.company_id !== s.companyId || !['STANDARD', 'KIT', 'SERVICE'].includes(row.item_kind) || typeof row.item_name !== 'string' || !row.item_name.trim()) blocked(field, 'Falta el contexto confirmado del producto.')
    const quantity = decimal(row.qty, `${field}.quantity`, 6, true), price = decimal(row.price, `${field}.price`, 18), net = decimal(row.net_total, `${field}.netTotal`)
    const gross = decimal(lineTotal(quantity, price), `${field}.gross`), discount = gross.sub(net)
    if (discount.lt(0)) blocked(field, 'El total neto excede el importe de la línea.')
    let unit = row.unit_snapshot, baseQuantity = row.base_qty
    let kind, targetId
    if (row.unit_metadata_version === 2 && unit?.version === 2 && unit.baseUnit?.id) { kind = unit.presentation ? 'PRESENTATION' : 'UNIT'; targetId = unit.presentation?.id || unit.baseUnit.id }
    else if (row.unit_metadata_version === 1 && unit?.version === 1) { kind = 'LEGACY_PRODUCT'; targetId = row.product_id }
    else if (row.unit_metadata_version === 1 && unit === null && baseQuantity === null) {
      if (typeof row.unit_label !== 'string' || !row.unit_label.trim() || !Number.isInteger(row.quantity_decimals) || row.quantity_decimals < 0 || row.quantity_decimals > 6) blocked(`${field}.unit`)
      // v1 persists these commercial fields, not a conversion snapshot; never consult today's catalog.
      unit = { version: 1, unit_label: row.unit_label, quantity_decimals: row.quantity_decimals, factor: '1' }
      baseQuantity = decimal(row.qty, `${field}.quantity`, row.quantity_decimals, true).toFixed()
      kind = 'LEGACY_PRODUCT'; targetId = row.product_id
    }
    else blocked(`${field}.unit`, 'Falta el snapshot de unidad confirmado; no se usa la unidad actual del producto.')
    const mapping = profile.unitMap.find(map => map.kind === kind && map.targetId === targetId)
    if (!mapping) blocked(`${field}.unit`, 'Esta unidad o presentación todavía no tiene un código fiscal explícito.')
    const taxId = profile.productTaxMap.find(map => map.productId === row.product_id)?.taxRuleId || profile.categoryTaxMap.find(map => map.categoryId === product.category_id)?.taxRuleId
    const taxRule = profile.taxRules.find(rule => rule.id === taxId)
    if (!taxRule) blocked(`${field}.tax`, 'Este producto no tiene una regla fiscal explícita.')
    if (profile.documentType === 'FPEQ' && taxRule.mode !== 'NO_BREAKDOWN' || profile.documentType === 'FACT' && taxRule.mode === 'NO_BREAKDOWN') blocked(`${field}.tax`, 'La regla no corresponde al tipo de este borrador local.')
    const rate = decimal(taxRule.rate, `${field}.taxRate`, 6)
    const taxable = taxRule.mode === 'INCLUDED' ? net.div(rate.add(1)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) : net
    const tax = net.sub(taxable)
    grossSum = grossSum.add(gross); discountSum = discountSum.add(discount); taxableSum = taxableSum.add(taxable); taxSum = taxSum.add(tax); netSum = netSum.add(net)
    return { sourceLineId: row.id, productId: row.product_id, categoryId: product.category_id, name: row.item_name, kind: row.item_kind === 'SERVICE' ? 'SERVICE' : 'GOOD', quantity: quantity.toFixed(), unitPrice: price.toFixed(), gross: gross.toFixed(2), discount: discount.toFixed(2), total: net.toFixed(2), taxable: taxable.toFixed(2), tax: tax.toFixed(2), taxRule: structuredClone(taxRule), satUnitCode: mapping.satCode, unitSnapshot: structuredClone(unit), baseQuantity: decimal(baseQuantity, `${field}.baseQuantity`, 6, true).toFixed() }
  })
  if (!grossSum.eq(decimal(sale.subtotal, 'subtotal')) || !discountSum.eq(decimal(sale.discount_total === null ? '0' : sale.discount_total, 'discount')) || !netSum.eq(decimal(sale.total, 'total')) || !taxableSum.add(taxSum).eq(netSum)) blocked('totals', 'Los importes congelados no cuadran; no se ajustarán centavos automáticamente.')
  if (!options.renderProfiles || typeof options.renderProfiles !== 'object' || Array.isArray(options.renderProfiles)) blocked('renderProfiles')
  const result = { version: 1, source: options.source, companyId: s.companyId, branchId: s.branchId, saleId: sale.id, connectorVersionId: version.id, contractId: version.contract_id, environment: version.environment, currency: profile.currency, issuedAt, verification: 'UNCONFIRMED', externalSendingAllowed: false, profile: structuredClone(profile), emitter: structuredClone(profile.emitter), establishment: structuredClone(establishment), receiver, lines, totals: { gross: grossSum.toFixed(2), discount: discountSum.toFixed(2), taxable: taxableSum.toFixed(2), tax: taxSum.toFixed(2), total: netSum.toFixed(2) }, renderProfiles: structuredClone(options.renderProfiles) }
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) blocked('snapshot', 'La preparación excede el tamaño local permitido.')
  return freeze(result)
}
module.exports = { prepareFiscalSnapshot }
