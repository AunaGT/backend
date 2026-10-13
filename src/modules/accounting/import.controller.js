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
 * Importación masiva de contabilidad (mismo flujo que catálogos/productos):
 * plantilla Excel + validate-import + bulk-import con campos ya mapeados.
 * - Cuentas: crea las nuevas por código; las existentes se omiten.
 * - Asientos: agrupa filas por referencia y crea asientos MANUAL validados.
 */

const XLSX = require('xlsx')
const { prisma } = require('../../models/prisma')
const { createEntry, periodKeyForDate, AccountingError } = require('../../services/accounting/core')
const { toCents } = require('../../services/accounting/logic')
const { runImportStream, ImportCancelledError } = require('../../utils/importStream')

const { rowSet, nameMatcher, checkSimilarity, checkText, validMoney } = require('../../utils/importValidation')
const MAX_ROWS = 2000

const norm = (v) => String(v ?? '').trim()
const normKey = (v) => norm(v).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')

const TYPE_MAP = {
  activo: 'ASSET', asset: 'ASSET',
  pasivo: 'LIABILITY', liability: 'LIABILITY',
  capital: 'EQUITY', patrimonio: 'EQUITY', equity: 'EQUITY',
  ingreso: 'INCOME', ingresos: 'INCOME', income: 'INCOME',
  costo: 'COST', costos: 'COST', cost: 'COST',
  gasto: 'EXPENSE', gastos: 'EXPENSE', expense: 'EXPENSE',
}

const TRUTHY = new Set(['si', 'yes', 'true', '1', 'x'])
const FALSY = new Set(['no', 'false', '0', ''])

/** Número desde celda Excel ("1,234.56", 1234.56, ''). null si inválido. */
function parseNumberCell(v) {
  if (v == null || v === '') return 0
  const text = String(v).trim()
  if (text.includes(',') && !/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return null
  const n = Number(text.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Fecha desde celda Excel: serial numérico, yyyy-mm-dd o dd/mm/yyyy. */
function parseDateCell(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(Math.round((v - 25569) * 86400000)) // serial Excel → epoch
    return Number.isNaN(d.getTime()) ? null : d
  }
  const s = norm(v)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m && s === m[0]) return calendarDate(Number(m[1]), Number(m[2]), Number(m[3]))
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (m && s === m[0]) return calendarDate(Number(m[3]), Number(m[2]), Number(m[1]))
  return null
}

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 18))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null
}

function sendTemplate(res, filename, headers, examples, colWidths) {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([headers, ...examples])
  ws['!cols'] = colWidths.map((wch) => ({ wch }))
  XLSX.utils.book_append_sheet(wb, ws, 'Plantilla')
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

function checkItems(req, res) {
  const { items } = req.body || {}
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: 'No se proporcionaron filas para procesar' })
    return null
  }
  if (items.length > MAX_ROWS) {
    res.status(400).json({ message: `Máximo ${MAX_ROWS} filas por importación` })
    return null
  }
  return items
}

// ============ CUENTAS ============

exports.accountsTemplate = (req, res, next) => {
  try {
    sendTemplate(res, 'plantilla_cuentas.xlsx',
      ['codigo', 'nombre', 'tipo', 'cuenta_padre', 'agrupadora'],
      [
        ['1200', 'ACTIVO NO CORRIENTE', 'Activo', '1', 'si'],
        ['1201', 'Mobiliario y Equipo', 'Activo', '1200', ''],
        ['2104', 'Préstamos Bancarios', 'Pasivo', '2', ''],
        ['6106', 'Publicidad', 'Gastos', '6', ''],
      ],
      [12, 34, 12, 14, 12])
  } catch (e) { next(e) }
}

/** Valida cuentas y calcula orden de creación (padres antes que hijas). */
async function validateAccounts(items, companyId, options = {}) {
  const skips = rowSet(options, 'skipRowIndexes')
  const rows = items.map((it, i) => ({
    rowIndex: i,
    code: norm(it.code),
    name: norm(it.name),
    typeRaw: normKey(it.type),
    parent: norm(it.parent),
    isGroupRaw: normKey(it.isGroup),
  })).filter(row => !skips.has(row.rowIndex))

  const codesInFile = new Map() // code → primera fila que lo usa
  const existing = await prisma.account.findMany({
    where: { code: { in: rows.map((r) => r.code).filter(Boolean) }, company_id: companyId },
    select: { id: true, code: true },
  })
  const existingByCode = new Map(existing.map((a) => [a.code, a]))
  const allAccounts = await prisma.account.findMany({ where: { company_id: companyId }, select: { code: true, name: true } })
  const allDbCodes = new Set(allAccounts.map(a => a.code))
  const matchName = nameMatcher(allAccounts)

  const invalidRows = []
  for (const r of rows) {
    const errors = []
    if (!r.code) errors.push('código: requerido')
    else if (codesInFile.has(r.code)) errors.push(`código: "${r.code}" duplicado en el archivo (fila ${codesInFile.get(r.code) + 2})`)
    else codesInFile.set(r.code, r.rowIndex)
    if (!r.name) errors.push('nombre: requerido')
    if (!r.typeRaw) errors.push('tipo: requerido (Activo, Pasivo, Capital, Ingresos, Costos o Gastos)')
    else if (!TYPE_MAP[r.typeRaw]) errors.push(`tipo: "${norm(items[r.rowIndex].type)}" no reconocido (usa Activo, Pasivo, Capital, Ingresos, Costos o Gastos)`)
    if (r.isGroupRaw && !TRUTHY.has(r.isGroupRaw) && !FALSY.has(r.isGroupRaw)) {
      errors.push(`agrupadora: "${norm(items[r.rowIndex].isGroup)}" no reconocido (usa si/no)`)
    }
    if (r.parent && r.parent === r.code) errors.push('cuenta padre: no puede ser la misma cuenta')
    if (r.parent && !allDbCodes.has(r.parent) && !rows.some((o) => o.code === r.parent)) {
      errors.push(`cuenta padre: "${r.parent}" no existe ni viene en el archivo`)
    }
    r.type = TYPE_MAP[r.typeRaw] || null
    r.isGroup = TRUTHY.has(r.isGroupRaw)
    r.exists = existingByCode.has(r.code)
    checkText(r, { name: 150, code: 20 }, errors)
    const issue = { rowIndex: r.rowIndex, errors, existingProductId: r.exists }
    checkSimilarity(issue, r.name, matchName, options, 2)
    if (errors.length) invalidRows.push(issue)
  }

  // Orden de creación por pases (padres primero); detecta referencias circulares.
  const invalidSet = new Set(invalidRows.map((x) => x.rowIndex))
  let pending = rows.filter((r) => !invalidSet.has(r.rowIndex) && !r.exists)
  const resolvable = new Set(allDbCodes)
  const ordered = []
  let progress = true
  while (pending.length && progress) {
    progress = false
    const rest = []
    for (const r of pending) {
      if (!r.parent || resolvable.has(r.parent)) {
        ordered.push(r)
        resolvable.add(r.code)
        progress = true
      } else rest.push(r)
    }
    pending = rest
  }
  for (const r of pending) {
    invalidRows.push({ rowIndex: r.rowIndex, errors: [`cuenta padre: referencia circular con "${r.parent}"`] })
  }

  invalidRows.sort((a, b) => a.rowIndex - b.rowIndex)
  const skipped = [...rows.filter((r) => r.exists && !invalidRows.some((x) => x.rowIndex === r.rowIndex)), ...items.flatMap((_, rowIndex) => skips.has(rowIndex) ? [{ rowIndex }] : [])]
  return { rows, ordered, skipped, invalidRows }
}

exports.validateAccountsImport = async (req, res, next) => {
  try {
    const items = checkItems(req, res)
    if (!items) return
    const v = await validateAccounts(items, req.companyId, req.body?.importOptions)
    res.json({
      ok: true,
      totals: { total: items.length, valid: items.length - v.invalidRows.length - v.skipped.length, invalid: v.invalidRows.length, skipped: v.skipped.length },
      skippedRows: v.skipped,
      skipped: v.skipped.length,
      invalidRows: v.invalidRows,
      validRows: [],
    })
  } catch (e) { next(e) }
}

async function persistAccounts(v, companyId, onProgress = () => {}, isCancelled = () => false) {
  let processed = 0
  await prisma.$transaction(async (tx) => {
    const idByCode = new Map((await tx.account.findMany({ where: { company_id: companyId }, select: { id: true, code: true } })).map(a => [a.code, a.id]))
    for (const r of v.ordered) {
      if (isCancelled()) throw new ImportCancelledError()
      const created = await tx.account.create({ data: {
        company_id: companyId, code: r.code, name: r.name, type: r.type,
        is_group: r.isGroup, parent_id: r.parent ? (idByCode.get(r.parent) ?? null) : null,
      } })
      idByCode.set(r.code, created.id)
      onProgress({ processed: ++processed, total: v.ordered.length })
    }
    if (isCancelled()) throw new ImportCancelledError()
  }, { timeout: 60000, maxWait: 10000 })
  return { created: v.ordered.length, skipped: v.skipped.length }
}

exports.bulkImportAccounts = async (req, res, next) => {
  try {
    const items = checkItems(req, res)
    if (!items) return
    const v = await validateAccounts(items, req.companyId, req.body?.importOptions)
    if (v.invalidRows.length > 0) {
      return res.status(400).json({
        message: `${v.invalidRows.length} filas tienen errores`,
        totals: { total: items.length, valid: items.length - v.invalidRows.length - v.skipped.length, invalid: v.invalidRows.length, skipped: v.skipped.length },
        skippedRows: v.skipped,
        invalidRows: v.invalidRows,
      })
    }

    const { created } = await persistAccounts(v, req.companyId)
    res.json({
      ok: true,
      created,
      skipped: v.skipped.length,
      message: v.skipped.length > 0
        ? `Se importaron ${created} cuentas (${v.skipped.length} omitidas: el código ya existe)`
        : `Se importaron ${created} cuentas exitosamente`,
    })
  } catch (e) {
    if (e instanceof AccountingError) return res.status(400).json({ message: e.message })
    next(e)
  }
}

exports.bulkImportAccountsStream = async (req, res) => {
  const items = checkItems(req, res)
  if (!items) return
  let validated
  await runImportStream(res, {
    total: items.length,
    validate: async () => { validated = await validateAccounts(items, req.companyId, req.body?.importOptions); return { validRows: validated.ordered, invalidRows: validated.invalidRows } },
    save: (_rows, onProgress, isCancelled) => persistAccounts(validated, req.companyId, onProgress, isCancelled),
  })
}

// ============ ASIENTOS (DIARIO) ============

exports.journalTemplate = (req, res, next) => {
  try {
    sendTemplate(res, 'plantilla_asientos.xlsx',
      ['referencia', 'fecha', 'descripcion', 'cuenta', 'debe', 'haber'],
      [
        ['AP-1', '01/01/2026', 'Asiento de apertura', '1101', 5000, ''],
        ['AP-1', '01/01/2026', 'Asiento de apertura', '1105', 20000, ''],
        ['AP-1', '01/01/2026', 'Asiento de apertura', '3101', '', 25000],
      ],
      [12, 12, 34, 12, 12, 12])
  } catch (e) { next(e) }
}

/** Valida filas de asientos: cuentas, montos y cuadre por referencia. */
async function validateJournal(items, companyId, options = {}) {
  const skips = rowSet(options, 'skipRowIndexes')
  const skipReferences = new Set(items.filter((_, i) => skips.has(i)).map(item => norm(item.reference)).filter(Boolean))
  const skipped = items.flatMap((item, rowIndex) => skips.has(rowIndex) || skipReferences.has(norm(item.reference)) ? [{ rowIndex, reason: 'Asiento omitido por el usuario' }] : [])
  const skippedSet = new Set(skipped.map(row => row.rowIndex))
  const rows = items.map((it, i) => ({
    rowIndex: i,
    reference: norm(it.reference),
    date: parseDateCell(it.date),
    dateRaw: norm(it.date),
    description: norm(it.description),
    accountCode: norm(it.accountCode),
    debit: parseNumberCell(it.debit),
    credit: parseNumberCell(it.credit),
  })).filter(row => !skippedSet.has(row.rowIndex))

  const accounts = await prisma.account.findMany({
    where: { code: { in: [...new Set(rows.map((r) => r.accountCode).filter(Boolean))] }, company_id: companyId },
  })
  const accByCode = new Map(accounts.map((a) => [a.code, a]))

  const errorsByRow = new Map()
  const similarRows = new Set()
  const duplicateLines = new Map()
  const allowedSimilarRows = rowSet(options, 'allowSimilarRowIndexes')
  const addError = (i, msg) => {
    if (!errorsByRow.has(i)) errorsByRow.set(i, [])
    errorsByRow.get(i).push(msg)
  }

  for (const r of rows) {
    const textErrors = []
    checkText(r, { reference: 100, description: 255, accountCode: 20 }, textErrors)
    textErrors.forEach(message => addError(r.rowIndex, message))
    if (!r.reference) addError(r.rowIndex, 'referencia: requerida (agrupa las líneas de un mismo asiento)')
    if (!r.date || Number.isNaN(r.date.getTime())) { r.date = null; addError(r.rowIndex, `fecha: "${r.dateRaw}" inválida (usa dd/mm/aaaa o aaaa-mm-dd)`) }
    const acc = accByCode.get(r.accountCode)
    if (!r.accountCode) addError(r.rowIndex, 'cuenta: requerida (código del catálogo)')
    else if (!acc) addError(r.rowIndex, `cuenta: "${r.accountCode}" no existe en el catálogo`)
    else if (!acc.active) addError(r.rowIndex, `cuenta: ${acc.code} ${acc.name} está inactiva`)
    else if (acc.is_group) addError(r.rowIndex, `cuenta: ${acc.code} ${acc.name} es agrupadora y no recibe movimientos`)
    if (!validMoney(r.debit) || !validMoney(r.credit)) {
      addError(r.rowIndex, 'debe/haber: montos inválidos (0–9999999999.99, hasta 2 decimales)')
    } else if ((r.debit > 0) === (r.credit > 0)) {
      addError(r.rowIndex, 'debe/haber: cada línea lleva debe o haber (no ambos, no vacíos)')
    }
    const signature = JSON.stringify([r.reference, r.date?.toISOString(), r.accountCode, r.debit, r.credit])
    if (duplicateLines.has(signature) && !errorsByRow.has(r.rowIndex) && !allowedSimilarRows.has(r.rowIndex)) {
      addError(r.rowIndex, `Movimiento idéntico a la fila ${duplicateLines.get(signature) + 2}. Revisa antes de crear igualmente.`)
      similarRows.add(r.rowIndex)
    }
    duplicateLines.set(signature, r.rowIndex)
    r.account = acc || null
  }

  // Agrupar por referencia (en orden de aparición) y validar cuadre/fechas/período
  const groups = new Map()
  for (const r of rows) {
    const textErrors = []
    checkText(r, { reference: 100, description: 255, accountCode: 20 }, textErrors)
    textErrors.forEach(message => addError(r.rowIndex, message))
    if (!r.reference) continue
    if (!groups.has(r.reference)) groups.set(r.reference, [])
    groups.get(r.reference).push(r)
  }
  const closedPeriods = new Set(
    (await prisma.accountingPeriod.findMany({ where: { status: 'CLOSED', company_id: companyId }, select: { year: true, month: true } }))
      .map((p) => `${p.year}-${p.month}`),
  )
  for (const [ref, group] of groups) {
    const first = group[0].rowIndex
    if (group.length < 2) addError(first, `referencia "${ref}": un asiento requiere al menos 2 líneas`)
    const dates = new Set(group.map((r) => (r.date ? r.date.toISOString().slice(0, 10) : '')))
    if (dates.size > 1) addError(first, `referencia "${ref}": todas las líneas deben tener la misma fecha`)
    const debits = group.reduce((s, r) => s + toCents(r.debit || 0), 0)
    const credits = group.reduce((s, r) => s + toCents(r.credit || 0), 0)
    if (debits !== credits) addError(first, `referencia "${ref}": descuadrado (debe ${debits / 100} ≠ haber ${credits / 100})`)
    if (group[0].date) {
      const { year, month } = periodKeyForDate(group[0].date)
      if (closedPeriods.has(`${year}-${month}`)) {
        addError(first, `fecha: el período ${String(month).padStart(2, '0')}/${year} está cerrado`)
      }
    }
  }

  const invalidRows = [...errorsByRow.entries()]
    .map(([rowIndex, errors]) => ({ rowIndex, errors, canCreateAnyway: similarRows.has(rowIndex) }))
    .sort((a, b) => a.rowIndex - b.rowIndex)
  return { rows, groups, invalidRows, skipped }
}

exports.validateJournalImport = async (req, res, next) => {
  try {
    const items = checkItems(req, res)
    if (!items) return
    const v = await validateJournal(items, req.companyId, req.body?.importOptions)
    res.json({
      ok: true,
      totals: { total: items.length, valid: items.length - v.invalidRows.length - v.skipped.length, invalid: v.invalidRows.length, skipped: v.skipped.length },
      skippedRows: v.skipped,
      entries: v.groups.size,
      invalidRows: v.invalidRows,
      validRows: [],
    })
  } catch (e) { next(e) }
}

async function persistJournal(v, req, onProgress = () => {}, isCancelled = () => false) {
  const numbers = []
  let processed = 0
  await prisma.$transaction(async (tx) => {
    for (const [ref, group] of v.groups) {
      if (isCancelled()) throw new ImportCancelledError()
      const entry = await createEntry(tx, {
        company_id: req.companyId,
        date: group[0].date,
        description: group.find(r => r.description)?.description || `Asiento importado ${ref}`,
        source_type: 'MANUAL', created_by: req.user?.sub ?? null,
        lines: group.map(r => ({ account_id: r.account.id, debit: r.debit, credit: r.credit, description: r.description || null })),
      })
      numbers.push(entry.entry_number)
      processed += group.length
      onProgress({ processed, total: v.rows.length })
    }
    if (isCancelled()) throw new ImportCancelledError()
  }, { timeout: 60000, maxWait: 10000 })
  return { created: numbers.length, skipped: v.skipped.length, message: `Se importaron ${numbers.length} asientos (${numbers[0]} a ${numbers[numbers.length - 1]})` }
}

exports.bulkImportJournal = async (req, res, next) => {
  try {
    const items = checkItems(req, res)
    if (!items) return
    const v = await validateJournal(items, req.companyId, req.body?.importOptions)
    if (v.invalidRows.length > 0) {
      return res.status(400).json({
        message: `${v.invalidRows.length} filas tienen errores`,
        totals: { total: items.length, valid: items.length - v.invalidRows.length - v.skipped.length, invalid: v.invalidRows.length, skipped: v.skipped.length },
        skippedRows: v.skipped,
        invalidRows: v.invalidRows,
      })
    }

    const result = await persistJournal(v, req)
    res.json({
      ok: true,
      ...result,
    })
  } catch (e) {
    if (e instanceof AccountingError) return res.status(400).json({ message: e.message })
    next(e)
  }
}

exports.bulkImportJournalStream = async (req, res) => {
  const items = checkItems(req, res)
  if (!items) return
  let validated
  await runImportStream(res, {
    total: items.length,
    validate: async () => { validated = await validateJournal(items, req.companyId, req.body?.importOptions); return { validRows: validated.rows, invalidRows: validated.invalidRows } },
    save: (_rows, onProgress, isCancelled) => persistJournal(validated, req, onProgress, isCancelled),
  })
}
