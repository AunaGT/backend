/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/** Núcleo contable: creación de asientos validados, períodos y numeración. */

const { DateTime } = require('luxon')
const { validateLines, round2 } = require('./logic')

const GT_ZONE = 'America/Guatemala'
const SETTING_KEY = 'accounting.defaultAccounts'
const ENTRY_LOCK_KEY = 910004

const DEFAULT_ACCOUNT_KEYS = [
  'cash', 'bank', 'receivables', 'sales', 'salesReturns', 'cogs', 'inventory',
  'payables', 'ivaDebit', 'ivaCredit', 'pequenoTax', 'pequenoTaxExpense',
  'currentEarnings', 'retainedEarnings',
]

/**
 * Cuentas que necesita el posteo de nómina. Deliberadamente separadas de
 * DEFAULT_ACCOUNT_KEYS: getDefaultAccounts revienta si falta CUALQUIER clave de
 * esa lista, así que meterlas ahí dejaría sin postear ventas y compras a toda
 * empresa que todavía no las tenga configuradas. Si faltan, falla el posteo de
 * nómina y nada más.
 */
const PAYROLL_ACCOUNT_KEYS = [
  'cash', 'bank',
  'payrollAdvances', 'payrollIgssPayable', 'payrollIsrPayable',
  'payrollProvisionsPayable', 'payrollWagesPayable',
  'payrollWagesExpense', 'payrollBonificacion', 'payrollEmployerCost',
  'payrollProvisionsExpense',
]

class AccountingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccountingError'
    this.status = 400
  }
}

/**
 * Fecha de asiento: un 'yyyy-mm-dd' plano se interpreta en zona Guatemala
 * (mediodía), no como medianoche UTC — evita que caiga al día/período anterior.
 */
function toEntryDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return new Date(`${value.trim()}T12:00:00-06:00`)
  }
  return new Date(value)
}

/** Año/mes contable de una fecha, en zona Guatemala. */
function periodKeyForDate(date) {
  const dt = DateTime.fromJSDate(toEntryDate(date), { zone: GT_ZONE })
  return { year: dt.year, month: dt.month }
}

/** Auto-crea el período OPEN si no existe; lanza si está CLOSED. Por empresa. */
async function assertPeriodOpen(tx, date, companyId) {
  const { year, month } = periodKeyForDate(date)
  const period = await tx.accountingPeriod.upsert({
    where: { company_id_year_month: { company_id: companyId, year, month } },
    update: {},
    create: { company_id: companyId, year, month },
  })
  if (period.status === 'CLOSED') {
    throw new AccountingError(`El período ${String(month).padStart(2, '0')}/${year} está cerrado`)
  }
}

/** Número secuencial A-000001 por empresa (lock transaccional para evitar duplicados). */
async function nextEntryNumber(tx, companyId) {
  // Los casts son obligatorios: la forma de dos argumentos es (int, int) y
  // Prisma manda el número como bigint y el hash como integer.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENTRY_LOCK_KEY}::int, hashtext(${companyId})::int)`
  const last = await tx.journalEntry.findFirst({
    where: { company_id: companyId, entry_number: { startsWith: 'A-' } },
    orderBy: { entry_number: 'desc' },
    select: { entry_number: true },
  })
  const lastNum = last ? Number(last.entry_number.slice(2)) : 0
  const next = (Number.isFinite(lastNum) ? lastNum : 0) + 1
  return `A-${String(next).padStart(6, '0')}`
}

/**
 * Crea un asiento validado dentro de una transacción.
 * lines: [{ account_id, debit, credit, description? }]
 */
async function createEntry(tx, { company_id, branch_id = null, date, description, source_type = 'MANUAL', source_id = null, created_by = null, reversal_of_id = null, lines }) {
  if (!company_id) throw new AccountingError('company_id es obligatorio para crear asientos')
  const check = validateLines(lines)
  if (!check.ok) throw new AccountingError(check.error)

  const accountIds = [...new Set(lines.map((l) => Number(l.account_id)))]
  const accounts = await tx.account.findMany({ where: { id: { in: accountIds }, company_id } })
  const byId = new Map(accounts.map((a) => [a.id, a]))
  for (const id of accountIds) {
    const acc = byId.get(id)
    if (!acc) throw new AccountingError(`Cuenta ${id} no existe`)
    if (!acc.active) throw new AccountingError(`La cuenta ${acc.code} ${acc.name} está inactiva`)
    if (acc.is_group) throw new AccountingError(`La cuenta ${acc.code} ${acc.name} es agrupadora y no recibe movimientos`)
  }

  await assertPeriodOpen(tx, date, company_id)
  const entry_number = await nextEntryNumber(tx, company_id)

  return tx.journalEntry.create({
    data: {
      company_id,
      branch_id,
      entry_number,
      date: toEntryDate(date),
      description: String(description || '').slice(0, 255),
      source_type,
      source_id,
      created_by,
      reversal_of_id,
      lines: {
        create: lines.map((l) => ({
          account_id: Number(l.account_id),
          debit: round2(l.debit || 0),
          credit: round2(l.credit || 0),
          description: l.description ? String(l.description).slice(0, 255) : null,
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  })
}

/**
 * Configuración de impuestos (SystemSettings, editable desde la UI):
 * - `vat_affiliation`: régimen SAT. GENERAL desglosa IVA débito/crédito;
 *   PEQUENO no acredita IVA y paga una tarifa fija sobre ingresos brutos.
 * - `iva_rate` / `pequeno_rate`: tasas en % (defaults legales GT: 12 y 5).
 */
async function getTaxConfig(tx, companyId) {
  const rows = await tx.systemSetting.findMany({
    where: { key: { in: ['vat_affiliation', 'iva_rate', 'pequeno_rate'] }, company_id: companyId },
  })
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  const pct = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 && n < 100 ? n : fallback
  }
  return {
    regime: /peque/i.test(map.vat_affiliation || '') ? 'PEQUENO' : 'GENERAL',
    ivaRate: pct(map.iva_rate, 12) / 100,
    pequenoRate: pct(map.pequeno_rate, 5) / 100,
  }
}

/** Mapeo de cuentas por defecto (SystemSetting JSON { key: code }) resuelto a cuentas. */
async function getDefaultAccounts(tx, companyId) {
  const setting = await tx.systemSetting.findFirst({ where: { key: SETTING_KEY, company_id: companyId } })
  if (!setting) throw new AccountingError('Falta configurar las cuentas por defecto de contabilidad')
  let map
  try { map = JSON.parse(setting.value) } catch { throw new AccountingError('Configuración de cuentas por defecto inválida') }
  const codes = DEFAULT_ACCOUNT_KEYS.map((k) => map[k]).filter(Boolean)
  const accounts = await tx.account.findMany({ where: { code: { in: codes }, active: true, is_group: false, company_id: companyId } })
  const byCode = new Map(accounts.map((a) => [a.code, a]))
  const result = {}
  for (const key of DEFAULT_ACCOUNT_KEYS) {
    const code = map[key]
    const acc = code ? byCode.get(code) : null
    if (!acc) throw new AccountingError(`Cuenta por defecto «${key}» (${code || 'sin asignar'}) no encontrada o inactiva`)
    result[key] = acc
  }
  return result
}

/** Igual que getDefaultAccounts pero para la nómina, y con su propio 422. */
async function getPayrollAccounts(tx, companyId) {
  const setting = await tx.systemSetting.findFirst({ where: { key: SETTING_KEY, company_id: companyId } })
  let map = {}
  if (setting) {
    try { map = JSON.parse(setting.value) } catch { map = {} }
  }
  const codes = PAYROLL_ACCOUNT_KEYS.map((k) => map[k]).filter(Boolean)
  const accounts = await tx.account.findMany({
    where: { code: { in: codes }, active: true, is_group: false, company_id: companyId },
  })
  const byCode = new Map(accounts.map((a) => [a.code, a]))

  const result = {}
  const missing = []
  for (const key of PAYROLL_ACCOUNT_KEYS) {
    const code = map[key]
    const account = code ? byCode.get(code) : null
    if (!account) { missing.push(code ? `${key} (${code})` : key); continue }
    result[key] = account
  }
  if (missing.length > 0) {
    const err = new Error(`Falta configurar las cuentas contables de nómina: ${missing.join(', ')}`)
    err.status = 422
    throw err
  }
  return result
}

module.exports = {
  AccountingError,
  GT_ZONE,
  SETTING_KEY,
  DEFAULT_ACCOUNT_KEYS,
  PAYROLL_ACCOUNT_KEYS,
  toEntryDate,
  periodKeyForDate,
  assertPeriodOpen,
  nextEntryNumber,
  createEntry,
  getDefaultAccounts,
  getPayrollAccounts,
  getTaxConfig,
}
