/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/** Contabilidad: catálogo de cuentas, períodos, configuración, diario, posteo y cierre anual. */

const { prisma } = require('../models/prisma')
const { round2 } = require('../services/accounting/logic')
const {
  AccountingError, createEntry, getDefaultAccounts, periodKeyForDate,
  DEFAULT_ACCOUNT_KEYS, OPTIONAL_ACCOUNT_KEYS, SETTING_KEY,
} = require('../services/accounting/core')
const { postPendingOperations } = require('../services/accounting/postingEngine')

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST', 'EXPENSE']

function handle(e, res, next) {
  if (e instanceof AccountingError) return res.status(400).json({ error: e.message })
  return next(e)
}

function userId(req) {
  return req.user?.sub ?? null
}

function dateRange(req) {
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00-06:00`) : null
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999-06:00`) : null
  return { from, to }
}

// ---------- Catálogo de cuentas ----------

exports.listAccounts = async (req, res, next) => {
  try {
    const where = req.query.includeInactive === 'true' ? {} : { active: true }
    where.company_id = req.companyId
    const items = await prisma.account.findMany({ where, orderBy: { code: 'asc' } })
    res.json({ items })
  } catch (e) { next(e) }
}

exports.createAccount = async (req, res, next) => {
  try {
    const { code, name, type, parent_id, is_group } = req.body || {}
    if (!code || !name || !ACCOUNT_TYPES.includes(type)) {
      return res.status(400).json({ error: 'code, name y type válidos son requeridos' })
    }
    const exists = await prisma.account.findFirst({ where: { code: String(code).trim(), company_id: req.companyId } })
    if (exists) return res.status(400).json({ error: `Ya existe una cuenta con código ${code}` })
    const account = await prisma.account.create({
      data: {
        company_id: req.companyId,
        code: String(code).trim(),
        name: String(name).trim(),
        type,
        parent_id: parent_id ? Number(parent_id) : null,
        is_group: is_group === true,
      },
    })
    res.status(201).json(account)
  } catch (e) { next(e) }
}

exports.updateAccount = async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const account = await prisma.account.findFirst({ where: { id, company_id: req.companyId } })
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const { name, parent_id, active } = req.body || {}
    if (account.system && active === false) {
      return res.status(400).json({ error: 'Las cuentas de sistema no se pueden desactivar' })
    }
    const updated = await prisma.account.update({
      where: { id },
      data: {
        ...(name != null ? { name: String(name).trim() } : {}),
        ...(parent_id !== undefined ? { parent_id: parent_id ? Number(parent_id) : null } : {}),
        ...(active != null ? { active: Boolean(active) } : {}),
      },
    })
    res.json(updated)
  } catch (e) { next(e) }
}

// ---------- Períodos ----------

exports.listPeriods = async (req, res, next) => {
  try {
    const where = req.query.year ? { year: Number(req.query.year) } : {}
    where.company_id = req.companyId
    const items = await prisma.accountingPeriod.findMany({
      where,
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      include: { closedBy: { select: { name: true } } },
    })
    res.json({ items })
  } catch (e) { next(e) }
}

async function setPeriodStatus(req, res, next, status) {
  try {
    const year = Number(req.params.year)
    const month = Number(req.params.month)
    if (!year || month < 1 || month > 12) return res.status(400).json({ error: 'Período inválido' })
    const audit = {
      status,
      closed_at: status === 'CLOSED' ? new Date() : null,
      closed_by: status === 'CLOSED' ? userId(req) : null,
    }
    const period = await prisma.accountingPeriod.upsert({
      where: { company_id_year_month: { company_id: req.companyId, year, month } },
      update: audit,
      create: { company_id: req.companyId, year, month, ...audit },
    })
    res.json(period)
  } catch (e) { next(e) }
}

exports.closePeriod = (req, res, next) => setPeriodStatus(req, res, next, 'CLOSED')
exports.reopenPeriod = (req, res, next) => setPeriodStatus(req, res, next, 'OPEN')

// ---------- Configuración (mapeo de cuentas por defecto) ----------

exports.getConfig = async (req, res, next) => {
  try {
    const setting = await prisma.systemSetting.findFirst({ where: { key: SETTING_KEY, company_id: req.companyId } })
    let defaults = {}
    try { defaults = setting ? JSON.parse(setting.value) : {} } catch { defaults = {} }
    res.json({ defaults, keys: [...DEFAULT_ACCOUNT_KEYS, ...OPTIONAL_ACCOUNT_KEYS] })
  } catch (e) { next(e) }
}

exports.updateConfig = async (req, res, next) => {
  try {
    const incoming = req.body?.defaults || {}
    let current = {}
    const existing = await prisma.systemSetting.findFirst({ where: { key: SETTING_KEY, company_id: req.companyId } })
    if (existing) {
      try { current = JSON.parse(existing.value) } catch { current = {} }
    }
    const defaults = {}
    for (const key of DEFAULT_ACCOUNT_KEYS) {
      const code = incoming[key]
      if (!code) return res.status(400).json({ error: `Falta la cuenta para «${key}»` })
      const acc = await prisma.account.findFirst({ where: { code: String(code), company_id: req.companyId } })
      if (!acc || !acc.active || acc.is_group) {
        return res.status(400).json({ error: `Cuenta ${code} inválida para «${key}» (debe existir, activa y no agrupadora)` })
      }
      defaults[key] = String(code)
    }
    for (const key of OPTIONAL_ACCOUNT_KEYS) {
      const code = incoming[key] || current[key]
      if (!code) continue
      const acc = await prisma.account.findFirst({ where: { code: String(code), company_id: req.companyId } })
      if (!acc || !acc.active || acc.is_group) {
        return res.status(400).json({ error: `Cuenta ${code} inválida para «${key}» (debe existir, activa y no agrupadora)` })
      }
      defaults[key] = String(code)
    }
    await prisma.systemSetting.upsert({
      where: { company_id_key: { company_id: req.companyId, key: SETTING_KEY } },
      update: { value: JSON.stringify(defaults) },
      create: { company_id: req.companyId, key: SETTING_KEY, type: 'json', value: JSON.stringify(defaults), description: 'Mapeo de cuentas por defecto para asientos automáticos' },
    })
    res.json({ defaults, keys: [...DEFAULT_ACCOUNT_KEYS, ...OPTIONAL_ACCOUNT_KEYS] })
  } catch (e) { next(e) }
}

// ---------- Diario ----------

const ENTRY_INCLUDE = {
  lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { id: 'asc' } },
  createdBy: { select: { name: true } },
  branch: { select: { id: true, name: true, code: true } },
  reversals: { select: { id: true, entry_number: true } },
  reversalOf: { select: { id: true, entry_number: true } },
}

exports.listJournal = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)))
    const { from, to } = dateRange(req)
    const where = {
      company_id: req.companyId,
      ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(req.query.source ? { source_type: req.query.source } : {}),
      // 'company' = solo asientos sin sucursal (manuales, cierre, importación)
      ...(req.query.branch_id === 'company'
        ? { branch_id: null }
        : req.query.branch_id
          ? { branch_id: String(req.query.branch_id) }
          : {}),
    }
    const totalItems = await prisma.journalEntry.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    const items = await prisma.journalEntry.findMany({
      where,
      orderBy: [{ date: 'desc' }, { entry_number: 'desc' }],
      include: ENTRY_INCLUDE,
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })
    res.json({ items, page: safePage, pageSize, totalPages, totalItems })
  } catch (e) { next(e) }
}

exports.getJournalEntry = async (req, res, next) => {
  try {
    const entry = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      include: ENTRY_INCLUDE,
    })
    if (!entry) return res.status(404).json({ error: 'Asiento no encontrado' })
    res.json(entry)
  } catch (e) { next(e) }
}

exports.createManualEntry = async (req, res, next) => {
  try {
    const { date, description, lines } = req.body || {}
    if (!date || !description) return res.status(400).json({ error: 'Fecha y descripción son requeridas' })
    const entry = await prisma.$transaction((tx) =>
      createEntry(tx, { company_id: req.companyId, branch_id: req.branchId ?? null, date, description, source_type: 'MANUAL', created_by: userId(req), lines }),
    )
    res.status(201).json(entry)
  } catch (e) { handle(e, res, next) }
}

exports.reverseEntry = async (req, res, next) => {
  try {
    const original = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, company_id: req.companyId },
      include: { lines: true, reversals: { select: { id: true } } },
    })
    if (!original) return res.status(404).json({ error: 'Asiento no encontrado' })
    if (original.reversal_of_id) return res.status(400).json({ error: 'Un contra-asiento no se puede anular' })
    if (original.reversals.length > 0) return res.status(400).json({ error: 'Este asiento ya fue anulado' })

    // Fecha del contra-asiento: la del original si su período sigue abierto; si no, hoy.
    const { year, month } = periodKeyForDate(original.date)
    const period = await prisma.accountingPeriod.findFirst({ where: { company_id: req.companyId, year, month } })
    const reversalDate = period?.status === 'CLOSED' ? new Date() : original.date

    const entry = await prisma.$transaction((tx) =>
      createEntry(tx, {
        company_id: req.companyId,
        branch_id: original.branch_id,
        date: reversalDate,
        description: `Anulación de ${original.entry_number}: ${original.description}`.slice(0, 255),
        source_type: 'MANUAL',
        created_by: userId(req),
        reversal_of_id: original.id,
        lines: original.lines.map((l) => ({
          account_id: l.account_id,
          debit: Number(l.credit),
          credit: Number(l.debit),
          description: l.description,
        })),
      }),
    )
    res.status(201).json(entry)
  } catch (e) { handle(e, res, next) }
}

// ---------- Posteo automático ----------

exports.postPending = async (req, res, next) => {
  try {
    const result = await postPendingOperations(prisma, userId(req), req.companyId)
    res.json(result)
  } catch (e) { handle(e, res, next) }
}

// ---------- Cierre anual ----------

exports.closeYear = async (req, res, next) => {
  try {
    const year = Number(req.params.year)
    if (!year) return res.status(400).json({ error: 'Año inválido' })

    const closedCount = await prisma.accountingPeriod.count({ where: { year, status: 'CLOSED', company_id: req.companyId } })
    if (closedCount < 12) {
      return res.status(400).json({ error: 'Los 12 períodos del año deben existir y estar cerrados' })
    }
    const already = await prisma.journalEntry.findFirst({
      where: { company_id: req.companyId, source_type: 'CLOSING', source_id: `year:${year}` },
    })
    if (already) return res.status(400).json({ error: `El año ${year} ya fue cerrado (${already.entry_number})` })

    const from = new Date(`${year}-01-01T00:00:00-06:00`)
    const to = new Date(`${year}-12-31T23:59:59.999-06:00`)
    const grouped = await prisma.journalLine.groupBy({
      by: ['account_id'],
      where: { entry: { date: { gte: from, lte: to }, company_id: req.companyId }, account: { type: { in: ['INCOME', 'COST', 'EXPENSE'] } } },
      _sum: { debit: true, credit: true },
    })
    const accounts = await prisma.account.findMany({
      where: { id: { in: grouped.map((g) => g.account_id) } },
      select: { id: true, type: true },
    })
    const typeById = new Map(accounts.map((a) => [a.id, a.type]))

    const defaults = await getDefaultAccounts(prisma, req.companyId)
    const lines = []
    let result = 0 // + utilidad, - pérdida
    for (const g of grouped) {
      const debit = Number(g._sum.debit || 0)
      const credit = Number(g._sum.credit || 0)
      const type = typeById.get(g.account_id)
      // Saldo remanente de la cuenta de resultados en el año
      const balance = type === 'INCOME' ? round2(credit - debit) : round2(debit - credit)
      if (balance === 0) continue
      if (type === 'INCOME') {
        lines.push({ account_id: g.account_id, debit: balance, credit: 0 })
        result = round2(result + balance)
      } else {
        lines.push({ account_id: g.account_id, debit: 0, credit: balance })
        result = round2(result - balance)
      }
    }
    if (lines.length === 0) return res.status(400).json({ error: 'No hay resultados que cerrar en ese año' })
    // Contrapartida en Utilidad del Ejercicio y traslado inmediato a Utilidades Acumuladas
    if (result > 0) {
      lines.push({ account_id: defaults.currentEarnings.id, debit: 0, credit: result })
      lines.push({ account_id: defaults.currentEarnings.id, debit: result, credit: 0 })
      lines.push({ account_id: defaults.retainedEarnings.id, debit: 0, credit: result })
    } else if (result < 0) {
      const loss = Math.abs(result)
      lines.push({ account_id: defaults.currentEarnings.id, debit: loss, credit: 0 })
      lines.push({ account_id: defaults.currentEarnings.id, debit: 0, credit: loss })
      lines.push({ account_id: defaults.retainedEarnings.id, debit: loss, credit: 0 })
    }

    const entry = await prisma.$transaction(async (tx) => {
      // Reabrir dic momentáneamente para permitir el asiento de cierre y volver a cerrar
      await tx.accountingPeriod.update({ where: { company_id_year_month: { company_id: req.companyId, year, month: 12 } }, data: { status: 'OPEN' } })
      const created = await createEntry(tx, {
        company_id: req.companyId,
        date: to,
        description: `Cierre del ejercicio ${year}`,
        source_type: 'CLOSING',
        source_id: `year:${year}`,
        created_by: userId(req),
        lines,
      })
      await tx.accountingPeriod.update({
        where: { company_id_year_month: { company_id: req.companyId, year, month: 12 } },
        data: { status: 'CLOSED', closed_at: new Date(), closed_by: userId(req) },
      })
      return created
    })
    res.status(201).json(entry)
  } catch (e) { handle(e, res, next) }
}
