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
 * Catálogo de cuentas GT por defecto + mapeo de cuentas del motor de posteo.
 * Sin esto una empresa nueva no puede contabilizar nada (postingEngine
 * exige las 14 llaves de DEFAULT_ACCOUNT_KEYS resueltas).
 */

const ACCOUNTS_SEED = [
  { code: '1', name: 'ACTIVO', type: 'ASSET', is_group: true },
  { code: '1101', name: 'Caja', type: 'ASSET', parent: '1', system: true },
  { code: '1102', name: 'Bancos', type: 'ASSET', parent: '1', system: true },
  { code: '1103', name: 'Clientes', type: 'ASSET', parent: '1' },
  { code: '1104', name: 'IVA Crédito Fiscal', type: 'ASSET', parent: '1', system: true },
  { code: '1105', name: 'Inventario de Mercaderías', type: 'ASSET', parent: '1', system: true },
  { code: '1106', name: 'Anticipos a Empleados', type: 'ASSET', parent: '1', system: true },
  { code: '2', name: 'PASIVO', type: 'LIABILITY', is_group: true },
  { code: '2101', name: 'Proveedores', type: 'LIABILITY', parent: '2', system: true },
  { code: '2102', name: 'IVA Débito Fiscal', type: 'LIABILITY', parent: '2', system: true },
  { code: '2103', name: 'IVA Pequeño Contribuyente por Pagar', type: 'LIABILITY', parent: '2', system: true },
  { code: '2104', name: 'IGSS por Pagar', type: 'LIABILITY', parent: '2', system: true },
  { code: '2105', name: 'ISR Retenido por Pagar', type: 'LIABILITY', parent: '2', system: true },
  { code: '2106', name: 'Provisiones Laborales por Pagar', type: 'LIABILITY', parent: '2', system: true },
  { code: '2107', name: 'Sueldos por Pagar', type: 'LIABILITY', parent: '2', system: true },
  { code: '3', name: 'CAPITAL', type: 'EQUITY', is_group: true },
  { code: '3101', name: 'Capital', type: 'EQUITY', parent: '3' },
  { code: '3201', name: 'Utilidades Acumuladas', type: 'EQUITY', parent: '3', system: true },
  { code: '3202', name: 'Utilidad del Ejercicio', type: 'EQUITY', parent: '3', system: true },
  { code: '4', name: 'INGRESOS', type: 'INCOME', is_group: true },
  { code: '4101', name: 'Ventas', type: 'INCOME', parent: '4', system: true },
  { code: '4102', name: 'Devoluciones sobre Ventas', type: 'INCOME', parent: '4', system: true },
  { code: '5', name: 'COSTOS', type: 'COST', is_group: true },
  { code: '5101', name: 'Costo de Ventas', type: 'COST', parent: '5', system: true },
  { code: '6', name: 'GASTOS', type: 'EXPENSE', is_group: true },
  { code: '6101', name: 'Sueldos y Salarios', type: 'EXPENSE', parent: '6' },
  { code: '6102', name: 'Alquileres', type: 'EXPENSE', parent: '6' },
  { code: '6103', name: 'Servicios (agua, luz, internet)', type: 'EXPENSE', parent: '6' },
  { code: '6104', name: 'Otros Gastos', type: 'EXPENSE', parent: '6' },
  { code: '6105', name: 'IVA Pequeño Contribuyente (5%)', type: 'EXPENSE', parent: '6', system: true },
  { code: '6106', name: 'Bonificación Incentivo', type: 'EXPENSE', parent: '6', system: true },
  { code: '6107', name: 'Cuota Patronal (IGSS/IRTRA/INTECAP)', type: 'EXPENSE', parent: '6', system: true },
  { code: '6108', name: 'Provisiones Laborales', type: 'EXPENSE', parent: '6', system: true },
]

const DEFAULT_ACCOUNT_CODES = {
  cash: '1101', bank: '1102', receivables: '1103', sales: '4101', salesReturns: '4102',
  cogs: '5101', inventory: '1105', payables: '2101',
  ivaDebit: '2102', ivaCredit: '1104',
  pequenoTax: '2103', pequenoTaxExpense: '6105',
  currentEarnings: '3202', retainedEarnings: '3201',
  // Nómina. Van en este mismo mapeo (el seed hace merge, así que agregarlas es
  // aditivo), pero las resuelve getPayrollAccounts, NO getDefaultAccounts: si
  // entraran en DEFAULT_ACCOUNT_KEYS, una empresa sin ellas dejaría de postear
  // ventas y compras.
  payrollAdvances: '1106',
  payrollIgssPayable: '2104',
  payrollIsrPayable: '2105',
  payrollProvisionsPayable: '2106',
  payrollWagesPayable: '2107',
  payrollWagesExpense: '6101',
  payrollBonificacion: '6106',
  payrollEmployerCost: '6107',
  payrollProvisionsExpense: '6108',
}

/** Crea el catálogo de cuentas y el mapeo por defecto de una empresa; nunca pisa cuentas ya remapeadas. */
async function seedChartOfAccounts(tx, companyId) {
  const accountIdByCode = {}
  for (const acc of ACCOUNTS_SEED) {
    const created = await tx.account.upsert({
      where: { company_id_code: { company_id: companyId, code: acc.code } },
      update: {},
      create: {
        company_id: companyId,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        is_group: acc.is_group === true,
        system: acc.system === true,
        parent_id: acc.parent ? accountIdByCode[acc.parent] : null,
      },
    })
    accountIdByCode[acc.code] = created.id
  }

  const existingDefaults = await tx.systemSetting.findUnique({
    where: { company_id_key: { company_id: companyId, key: 'accounting.defaultAccounts' } },
  })
  let mergedDefaults = DEFAULT_ACCOUNT_CODES
  if (existingDefaults) {
    try { mergedDefaults = { ...DEFAULT_ACCOUNT_CODES, ...JSON.parse(existingDefaults.value) } } catch { /* JSON corrupto: se restaura el default */ }
  }
  await tx.systemSetting.upsert({
    where: { company_id_key: { company_id: companyId, key: 'accounting.defaultAccounts' } },
    update: { value: JSON.stringify(mergedDefaults) },
    create: {
      company_id: companyId,
      key: 'accounting.defaultAccounts',
      type: 'json',
      description: 'Mapeo de cuentas por defecto para asientos automáticos',
      value: JSON.stringify(mergedDefaults),
    },
  })
}

module.exports = { seedChartOfAccounts, ACCOUNTS_SEED, DEFAULT_ACCOUNT_CODES }
