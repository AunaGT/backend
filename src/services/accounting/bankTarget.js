const { isCashMethod } = require('../paymentMethods/behavior')
const isCash = method => isCashMethod(method, name => name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').includes('efectivo'))

/**
 * Cuenta de cargo según método de pago: crédito→Clientes, efectivo→Caja, resto→Bancos.
 *
 * El crédito se decide por la bandera `is_credit` y no por el nombre: un método
 * llamado «Crédito 30d» o con un typo caía en Bancos sin que nada lo avisara.
 * Los registros legados conservan su clasificación por nombre.
 */
function cashOrBank(defaults, paymentMethod) {
  if (paymentMethod?.is_credit) return defaults.receivables
  if (isCash(paymentMethod)) return defaults.cash
  return defaults.bank
}
// 4B: un cobro digital usa la cuenta congelada en su evento (banco del medio si es directo, transitoria si es diferido).
// Sin clasificación —históricos o medios sin configurar— sigue la regla de siempre.
function bankAccountFor(defaults, paymentMethod, frozenAccountId) {
  if (frozenAccountId && !paymentMethod?.is_credit && !isCash(paymentMethod)) return { id: frozenAccountId }
  return cashOrBank(defaults, paymentMethod)
}
// Cuentas congeladas por documento de origen; vacío si el DDL de 4B no está aplicado.
async function frozenBankAccounts(db, sourceType, ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))]
  if (!list.length || !(await db.$queryRaw`SELECT to_regclass('cash_bank_event_modes') IS NOT NULL AS ok`)[0]?.ok) return new Map()
  const rows = await db.$queryRaw`SELECT e.source_id::text AS source_id,m.account_id FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id
    WHERE e.source_type=${sourceType} AND e.source_id::text=ANY(${list}::text[]) AND m.account_id IS NOT NULL`
  return new Map(rows.map(r => [r.source_id, r.account_id]))
}
module.exports = { cashOrBank, bankAccountFor, frozenBankAccounts }
