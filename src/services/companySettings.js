/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Configuración inicial de una empresa. Sin esto una empresa recién creada
 * abre /configuracion en blanco: sin moneda, sin zona horaria y sin
 * denominaciones para cerrar caja.
 */

const DEFAULT_DENOMINATIONS = [
  { denomination: 200, type: 'Billete' }, { denomination: 100, type: 'Billete' },
  { denomination: 50, type: 'Billete' }, { denomination: 20, type: 'Billete' },
  { denomination: 10, type: 'Billete' }, { denomination: 5, type: 'Billete' },
  { denomination: 1, type: 'Billete' },
  { denomination: 0.5, type: 'Moneda' }, { denomination: 0.25, type: 'Moneda' },
  { denomination: 0.1, type: 'Moneda' }, { denomination: 0.05, type: 'Moneda' },
]

/**
 * Claves por defecto de una empresa. Las de identidad salen de la propia
 * empresa para que /configuracion y el selector muestren lo mismo desde el
 * primer día.
 * @param {{ name?: string, tax_id?: string, address?: string, logo_url?: string }} company
 */
function defaultCompanySettings(company = {}) {
  return [
    ['currency_code', 'GTQ', 'string'],
    ['currency_name', 'Quetzal', 'string'],
    ['timezone', 'America/Guatemala', 'string'],
    ['date_format', 'dd/MM/yyyy', 'string'],
    ['locale', 'es-GT', 'string'],
    ['company_name', company.name || 'Mi Empresa', 'string'],
    ['company_logo_url', company.logo_url || '', 'string'],
    ['company_nit', company.tax_id || '', 'string'],
    ['company_address', company.address || '', 'string'],
    ['company_municipality', '', 'string'],
    ['company_department', '', 'string'],
    ['company_postal_code', '', 'string'],
    ['establishment_code', '', 'string'],
    ['vat_affiliation', '', 'string'],
    ['cash_closure_denominations', JSON.stringify(DEFAULT_DENOMINATIONS), 'json'],
    ['cash_closure_max_diff_pct', '5', 'string'],
    ['quote_validity_days', '30', 'string'],
    ['order_validity_days', '7', 'string'],
    ['quote_soft_hold_hours', '48', 'string'],
    // Experiencia progresiva de venta. Estas banderas no conceden permisos.
    ['default_experience_profile', 'CASHIER', 'string'],
    ['sales_allow_credit', 'true', 'string'],
    ['sales_show_fiscal_fields', 'true', 'string'],
    ['sales_show_channels', 'true', 'string'],
  ]
}

/** Crea las claves que falten; nunca pisa lo ya configurado. */
async function seedCompanySettings(tx, companyId, company = {}) {
  for (const [key, value, type] of defaultCompanySettings(company)) {
    await tx.systemSetting.upsert({
      where: { company_id_key: { company_id: companyId, key } },
      update: {},
      create: { company_id: companyId, key, value, type },
    })
  }
}

module.exports = { seedCompanySettings, defaultCompanySettings, DEFAULT_DENOMINATIONS }
