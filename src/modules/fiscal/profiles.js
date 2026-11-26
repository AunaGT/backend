const { createHash } = require('node:crypto')
const { parseDecimal } = require('../../services/units/quantity')
const { fail } = require('./errors')
const { TAX_SETTING_KEYS, companyTaxConfig } = require('../../services/taxConfig')
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const PROFILE_BYTES = 128 * 1024
const EMITTER_KEYS = [...new Set(['company_legal_name', 'company_name', 'company_nit', 'company_address', 'company_municipality', 'company_department', 'company_postal_code', 'currency_code', ...TAX_SETTING_KEYS])]
function invalid(field) { throw fail(422, 'FISCAL_PROFILE_INVALID', 'Revisa los datos del perfil fiscal', { [field]: 'Ingresa un valor válido y sin duplicados.' }) }
function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(field)
}
function text(value, max, field, required = false) {
  if (typeof value !== 'string' || value.length > max || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || required && !value.trim()) invalid(field)
  return value.trim()
}
function id(value, field) { if (typeof value !== 'string' || !uuid.test(value)) invalid(field); return value.toLowerCase() }
function list(value, limit, field, map, unique) {
  if (!Array.isArray(value) || value.length > limit) invalid(field)
  const result = value.map((row, i) => map(row, `${field}.${i}`)), seen = new Set()
  for (const row of result) { const key = unique(row); if (seen.has(key)) invalid(field); seen.add(key) }
  return result
}
function normalizeProfileDraft(raw) {
  object(raw, ['documentType', 'taxRules', 'unitMap', 'productTaxMap', 'categoryTaxMap', 'establishments'], 'profile')
  if (Buffer.byteLength(JSON.stringify(raw)) > PROFILE_BYTES) throw fail(413, 'FISCAL_PROFILE_TOO_LARGE', 'El perfil supera 128 KiB; reduce los mapeos antes de guardarlo')
  if (!['', 'FACT', 'FPEQ'].includes(raw.documentType)) invalid('documentType')
  const taxRules = list(raw.taxRules, 40, 'taxRules', (row, path) => {
    object(row, ['id', 'name', 'mode', 'rate', 'exemptionCode'], path)
    const key = text(row.id, 40, `${path}.id`, true)
    if (!/^[\w-]+$/.test(key) || !['INCLUDED', 'EXEMPT', 'NO_BREAKDOWN'].includes(row.mode)) invalid(path)
    let rate
    try { if (typeof row.rate !== 'string') invalid(path); rate = parseDecimal(row.rate, { decimals: 6, allowZero: true, max: '1' }) } catch { invalid(`${path}.rate`) }
    if (row.mode === 'INCLUDED' ? !rate.gt(0) : !rate.isZero()) invalid(`${path}.rate`)
    return { id: key, name: text(row.name, 100, `${path}.name`, true), mode: row.mode, rate: rate.toFixed(), exemptionCode: text(row.exemptionCode ?? '', 40, `${path}.exemptionCode`, row.mode === 'EXEMPT') }
  }, row => row.id)
  const ruleIds = new Set(taxRules.map(row => row.id))
  const ruleId = (value, path) => { if (!ruleIds.has(value)) invalid(path); return value }
  const unitMap = list(raw.unitMap, 1000, 'unitMap', (row, path) => {
    object(row, ['kind', 'targetId', 'satCode'], path)
    if (!['UNIT', 'PRESENTATION', 'LEGACY_PRODUCT'].includes(row.kind)) invalid(path)
    const satCode = text(row.satCode, 20, `${path}.satCode`, true)
    if (!/^[\w.-]+$/.test(satCode)) invalid(`${path}.satCode`)
    return { kind: row.kind, targetId: id(row.targetId, `${path}.targetId`), satCode }
  }, row => `${row.kind}:${row.targetId}`)
  const productTaxMap = list(raw.productTaxMap, 1000, 'productTaxMap', (row, path) => { object(row, ['productId', 'taxRuleId'], path); return { productId: id(row.productId, `${path}.productId`), taxRuleId: ruleId(row.taxRuleId, path) } }, row => row.productId)
  const categoryTaxMap = list(raw.categoryTaxMap, 1000, 'categoryTaxMap', (row, path) => {
    object(row, ['categoryId', 'taxRuleId'], path)
    if (!Number.isSafeInteger(row.categoryId) || row.categoryId < 1) invalid(`${path}.categoryId`)
    return { categoryId: row.categoryId, taxRuleId: ruleId(row.taxRuleId, path) }
  }, row => row.categoryId)
  const establishments = list(raw.establishments, 200, 'establishments', (row, path) => {
    object(row, ['branchId', 'code', 'name', 'address', 'municipality', 'department', 'postalCode'], path)
    return { branchId: id(row.branchId, `${path}.branchId`), code: text(row.code, 20, `${path}.code`), name: text(row.name, 150, `${path}.name`), address: text(row.address, 500, `${path}.address`), municipality: text(row.municipality, 100, `${path}.municipality`), department: text(row.department, 100, `${path}.department`), postalCode: text(row.postalCode, 20, `${path}.postalCode`) }
  }, row => row.branchId)
  return { documentType: raw.documentType, taxRules, unitMap, productTaxMap, categoryTaxMap, establishments }
}
function issuerFromSettings(rows) {
  const values = Object.fromEntries(rows.filter(r => EMITTER_KEYS.includes(r.key)).map(r => [r.key, typeof r.value === 'string' ? r.value.trim() : '']))
  const emitter = { legalName: values.company_legal_name || '', commercialName: values.company_name || '', taxId: values.company_nit || '', address: values.company_address || '', municipality: values.company_municipality || '', department: values.company_department || '', postalCode: values.company_postal_code || '', vatAffiliation: values.vat_affiliation || '' }
  const currency = values.currency_code || ''
  const taxConfiguration = companyTaxConfig(rows)
  return { emitter, currency, taxConfiguration, settingsFingerprint: createHash('sha256').update(JSON.stringify([emitter, currency, taxConfiguration.revisionFingerprint])).digest('hex') }
}
function buildLocalProfile(draft, rows) {
  const profile = { version: 1, verification: 'UNCONFIRMED', policy: 'LOCAL_DRAFT_LINE_HALF_UP_2', ...normalizeProfileDraft(draft), ...issuerFromSettings(rows) }
  const fields = taxAlignmentIssues(profile)
  if (Object.keys(fields).length) throw fail(422, 'FISCAL_PROFILE_INVALID', 'Revisa la relación con los impuestos de Contabilidad', fields)
  return profile
}
function taxAlignmentIssues(profile) {
  const fields = {}, config = profile?.taxConfiguration
  if (!config || config.source !== 'COMPANY_SETTINGS') { fields.taxConfiguration = 'Este perfil usa reglas independientes. Revísalo y guárdalo con la configuración compartida de Contabilidad.'; return fields }
  for (const [index, rule] of (profile.taxRules || []).entries()) {
    if (rule.mode === 'INCLUDED' && (config.regime !== 'GENERAL' || config.ivaRate === null || config.ivaRate === '0' || rule.rate !== config.ivaRate)) fields[`taxRules.${index}.rate`] = 'Usa la tasa de IVA guardada en Contabilidad. No se admite otra tasa en el conector.'
    if (rule.mode === 'NO_BREAKDOWN' && config.regime !== 'PEQUENO' || rule.mode === 'EXEMPT' && config.regime !== 'GENERAL') fields[`taxRules.${index}.mode`] = 'El tratamiento no corresponde al régimen de la empresa.'
  }
  return fields
}
function profileIssues(profile) {
  const fields = {}
  Object.assign(fields, taxAlignmentIssues(profile))
  for (const [key, message] of Object.entries(profile?.taxConfiguration?.issues || {})) fields[`taxConfiguration.${key}`] = message
  for (const key of ['legalName', 'taxId', 'address', 'municipality', 'department', 'postalCode', 'vatAffiliation']) {
    const value = profile?.emitter?.[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 500 || [...value].some(c => c.charCodeAt(0) < 32)) fields[`emitter.${key}`] = 'Completa este dato en Configuración → Datos fiscales.'
  }
  if (!['general', 'pequeno_contribuyente'].includes(profile?.emitter?.vatAffiliation)) fields['emitter.vatAffiliation'] = 'Este régimen todavía no está preparado para una muestra local.'
  if (profile?.currency !== 'GTQ') fields.currency = 'La preparación local de esta etapa solo admite GTQ.'
  const type = profile?.emitter?.vatAffiliation === 'general' ? 'FACT' : profile?.emitter?.vatAffiliation === 'pequeno_contribuyente' ? 'FPEQ' : null
  if (!type || profile?.documentType !== type) fields.documentType = 'Selecciona el tipo compatible con el régimen de este borrador; pendiente de homologación.'
  if (!profile?.taxRules?.length) fields.taxRules = 'Define al menos una regla explícita; no se aplicará IVA automáticamente.'
  if (!profile?.productTaxMap?.length && !profile?.categoryTaxMap?.length) fields.taxMappings = 'Relaciona al menos una categoría o producto con una regla.'
  if (!profile?.unitMap?.length) fields.unitMap = 'Relaciona las unidades con sus códigos fiscales.'
  if (!profile?.establishments?.length) fields.establishments = 'Agrega el establecimiento de al menos una sucursal.'
  for (const [i, row] of (profile?.establishments || []).entries()) for (const key of ['code', 'name', 'address', 'municipality', 'department', 'postalCode']) if (!row[key]) fields[`establishments.${i}.${key}`] = 'Completa este dato del establecimiento.'
  return fields
}
module.exports = { PROFILE_BYTES, EMITTER_KEYS, normalizeProfileDraft, issuerFromSettings, buildLocalProfile, profileIssues }
