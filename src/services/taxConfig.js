const { createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')

const TAX_SETTING_KEYS = Object.freeze(['vat_affiliation', 'iva_rate', 'pequeno_rate'])
function companyTaxPercent(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d{1,2}(?:\.\d{1,4})?$/.test(String(value).trim())) return null
  return new Prisma.Decimal(String(value).trim()).toFixed()
}

// Shared company settings, not connector settings. Strict preparation must not
// turn accounting's historical fallbacks into an explicitly confirmed tax rate.
function companyTaxConfig(rows) {
  const values = new Map(rows.filter(row => TAX_SETTING_KEYS.includes(row.key)).map(row => [row.key, row]))
  const affiliation = values.get('vat_affiliation')?.value?.trim()
  const regime = affiliation === 'general' ? 'GENERAL' : affiliation === 'pequeno_contribuyente' ? 'PEQUENO' : null
  const issues = {}
  if (!regime) issues.vat_affiliation = 'Confirma el régimen de la empresa en Configuración → Datos fiscales.'
  const percent = key => {
    const value = values.get(key)?.value
    return typeof value === 'string' ? companyTaxPercent(value) : null
  }
  const ivaPercent = percent('iva_rate'), pequenoPercent = percent('pequeno_rate')
  if (regime === 'GENERAL' && ivaPercent === null) issues.iva_rate = 'Guarda una tasa de IVA válida en Configuración → Datos fiscales (hasta 4 decimales).'
  if (regime === 'PEQUENO' && pequenoPercent === null) issues.pequeno_rate = 'Guarda la tarifa de pequeño contribuyente en Configuración → Datos fiscales (hasta 4 decimales).'
  const revisionFingerprint = createHash('sha256').update(JSON.stringify(TAX_SETTING_KEYS.map(key => [key, values.get(key)?.value ?? null, values.get(key)?.revision ?? 0]))).digest('hex')
  return { source: 'COMPANY_SETTINGS', regime, ivaPercent, pequenoPercent,
    ivaRate: ivaPercent === null ? null : new Prisma.Decimal(ivaPercent).div(100).toFixed(),
    pequenoRate: pequenoPercent === null ? null : new Prisma.Decimal(pequenoPercent).div(100).toFixed(),
    revisionFingerprint, issues }
}

// Preserve the existing posting contract for legacy operations. This is not a
// declaration that missing settings are ready for FEL or legally verified.
function legacyAccountingTaxConfig(rows) {
  const map = Object.fromEntries(rows.map(row => [row.key, row.value]))
  const rate = (value, fallback) => { const n = Number(value); return (Number.isFinite(n) && n >= 0 && n < 100 ? n : fallback) / 100 }
  return { regime: /peque/i.test(map.vat_affiliation || '') ? 'PEQUENO' : 'GENERAL', ivaRate: rate(map.iva_rate, 12), pequenoRate: rate(map.pequeno_rate, 5) }
}

module.exports = { TAX_SETTING_KEYS, companyTaxPercent, companyTaxConfig, legacyAccountingTaxConfig }
