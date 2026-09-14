/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/** Reportes contables: Libro Mayor, Balanza, Estado de Resultados, Balance General e Impuestos. */

const { DateTime } = require('luxon')
const { prisma } = require('../../models/prisma')
const { accountBalance, isDebitNature, round2 } = require('../../services/accounting/logic')
const { getDefaultAccounts, getTaxConfig, GT_ZONE } = require('../../services/accounting/core')

/**
 * Alcance de los asientos: la empresa entera, o una sucursal como dimensión
 * analítica (centro de costo). 'company' = solo asientos sin sucursal.
 * Los asientos manuales y de cierre no tienen sucursal, así que un reporte
 * filtrado por sucursal muestra solo lo que esa sucursal originó.
 */
function entryScope(req, extra = {}) {
  const b = req.query.branch_id
  return {
    company_id: req.companyId,
    ...(b === 'company' ? { branch_id: null } : b ? { branch_id: String(b) } : {}),
    ...extra,
  }
}

function parseDate(value, endOfDay = false) {
  if (!value) return null
  return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}-06:00`)
}

/** Σ débitos/créditos por cuenta según filtro de líneas. */
async function sumsByAccount(where) {
  const grouped = await prisma.journalLine.groupBy({
    by: ['account_id'],
    where,
    _sum: { debit: true, credit: true },
  })
  const map = new Map()
  for (const g of grouped) {
    map.set(g.account_id, { debit: Number(g._sum.debit || 0), credit: Number(g._sum.credit || 0) })
  }
  return map
}

exports.ledger = async (req, res, next) => {
  try {
    const accountId = Number(req.params.accountId)
    const account = await prisma.account.findFirst({ where: { id: accountId, company_id: req.companyId } })
    if (!account) return res.status(404).json({ error: 'Cuenta no encontrada' })
    const from = parseDate(req.query.from)
    const to = parseDate(req.query.to, true)

    let initialBalance = 0
    if (from) {
      const prev = await prisma.journalLine.aggregate({
        where: { account_id: accountId, entry: entryScope(req, { date: { lt: from } }) },
        _sum: { debit: true, credit: true },
      })
      initialBalance = accountBalance(account.type, prev._sum.debit || 0, prev._sum.credit || 0)
    }

    const lines = await prisma.journalLine.findMany({
      where: {
        account_id: accountId,
        entry: entryScope(req, from || to
          ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      include: { entry: { select: { id: true, date: true, entry_number: true, description: true } } },
      orderBy: [{ entry: { date: 'asc' } }, { id: 'asc' }],
    })

    let running = initialBalance
    let totalDebit = 0
    let totalCredit = 0
    const movements = lines.map((l) => {
      const debit = Number(l.debit)
      const credit = Number(l.credit)
      totalDebit = round2(totalDebit + debit)
      totalCredit = round2(totalCredit + credit)
      running = round2(running + (isDebitNature(account.type) ? debit - credit : credit - debit))
      return {
        date: l.entry.date,
        entry_id: l.entry.id,
        entry_number: l.entry.entry_number,
        description: l.description || l.entry.description,
        debit, credit, balance: running,
      }
    })

    res.json({
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      initialBalance,
      movements,
      totals: { debit: totalDebit, credit: totalCredit },
      finalBalance: running,
    })
  } catch (e) { next(e) }
}

exports.trialBalance = async (req, res, next) => {
  try {
    const from = parseDate(req.query.from)
    const to = parseDate(req.query.to, true)

    const accounts = await prisma.account.findMany({ where: { is_group: false, company_id: req.companyId }, orderBy: { code: 'asc' } })
    const initial = from ? await sumsByAccount({ entry: entryScope(req, { date: { lt: from } }) }) : new Map()
    const period = await sumsByAccount({
      entry: entryScope(req, from || to
        ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    })

    const rows = []
    const totals = { debit: 0, credit: 0, initialDebit: 0, initialCredit: 0, finalDebit: 0, finalCredit: 0 }
    for (const acc of accounts) {
      const ini = initial.get(acc.id) || { debit: 0, credit: 0 }
      const mov = period.get(acc.id) || { debit: 0, credit: 0 }
      const initialBalance = accountBalance(acc.type, ini.debit, ini.credit)
      const finalBalance = accountBalance(acc.type, ini.debit + mov.debit, ini.credit + mov.credit)
      if (initialBalance === 0 && mov.debit === 0 && mov.credit === 0) continue
      rows.push({
        account_id: acc.id, code: acc.code, name: acc.name, type: acc.type,
        initialBalance, debit: round2(mov.debit), credit: round2(mov.credit), finalBalance,
      })
      totals.debit = round2(totals.debit + mov.debit)
      totals.credit = round2(totals.credit + mov.credit)
      // Saldos presentados en su columna natural (deudor / acreedor)
      if ((initialBalance >= 0) === isDebitNature(acc.type)) totals.initialDebit = round2(totals.initialDebit + Math.abs(initialBalance))
      else totals.initialCredit = round2(totals.initialCredit + Math.abs(initialBalance))
      if ((finalBalance >= 0) === isDebitNature(acc.type)) totals.finalDebit = round2(totals.finalDebit + Math.abs(finalBalance))
      else totals.finalCredit = round2(totals.finalCredit + Math.abs(finalBalance))
    }
    res.json({ rows, totals })
  } catch (e) { next(e) }
}

/** Filas { code, name, type, amount } por tipo de cuenta, con saldo según naturaleza. */
async function balancesByType(types, where, companyId) {
  const sums = await sumsByAccount(where)
  const accounts = await prisma.account.findMany({
    where: { is_group: false, type: { in: types }, company_id: companyId },
    orderBy: { code: 'asc' },
  })
  const rows = []
  for (const acc of accounts) {
    const s = sums.get(acc.id)
    if (!s) continue
    const amount = accountBalance(acc.type, s.debit, s.credit)
    if (amount === 0) continue
    rows.push({ code: acc.code, name: acc.name, type: acc.type, amount })
  }
  return rows
}

exports.incomeStatement = async (req, res, next) => {
  try {
    const from = parseDate(req.query.from)
    const to = parseDate(req.query.to, true)
    const where = {
      entry: entryScope(req, {
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        source_type: { not: 'CLOSING' }, // el cierre no distorsiona el P&L del rango
      }),
    }
    const rows = await balancesByType(['INCOME', 'COST', 'EXPENSE'], where, req.companyId)
    const income = rows.filter((r) => r.type === 'INCOME')
    const costs = rows.filter((r) => r.type === 'COST')
    const expenses = rows.filter((r) => r.type === 'EXPENSE')
    const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0))
    const totalCosts = round2(costs.reduce((s, r) => s + r.amount, 0))
    const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0))
    const grossProfit = round2(totalIncome - totalCosts)
    res.json({
      income, costs, expenses,
      totalIncome, totalCosts, grossProfit, totalExpenses,
      netIncome: round2(grossProfit - totalExpenses),
    })
  } catch (e) { next(e) }
}

exports.balanceSheet = async (req, res, next) => {
  try {
    const asOf = parseDate(req.query.asOf, true) || new Date()
    const whereUpTo = { entry: entryScope(req, { date: { lte: asOf } }) }

    const rows = await balancesByType(['ASSET', 'LIABILITY', 'EQUITY'], whereUpTo, req.companyId)
    const assets = rows.filter((r) => r.type === 'ASSET')
    const liabilities = rows.filter((r) => r.type === 'LIABILITY')
    const equity = rows.filter((r) => r.type === 'EQUITY')

    // Resultado no cerrado: INCOME − COST − EXPENSE acumulado hasta asOf.
    // Los asientos CLOSING ya saldan las cuentas de resultados de años cerrados,
    // así que este acumulado solo contiene el resultado pendiente de cierre.
    const resultRows = await balancesByType(['INCOME', 'COST', 'EXPENSE'], whereUpTo, req.companyId)
    const currentResult = round2(resultRows.reduce(
      (s, r) => s + (r.type === 'INCOME' ? r.amount : -r.amount), 0,
    ))

    const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0))
    const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0))
    const totalEquity = round2(equity.reduce((s, r) => s + r.amount, 0) + currentResult)
    res.json({
      asOf,
      assets, liabilities, equity,
      currentResult,
      totalAssets, totalLiabilities, totalEquity,
      balanced: Math.abs(round2(totalAssets - (totalLiabilities + totalEquity))) < 0.01,
    })
  } catch (e) { next(e) }
}

/**
 * Resultado por sucursal: la sucursal como centro de costo. Una sola consulta
 * agrupada; los asientos sin sucursal (manuales, importación) caen en "Empresa".
 */
exports.byBranch = async (req, res, next) => {
  try {
    const from = parseDate(req.query.from)
    const to = parseDate(req.query.to, true)

    const rows = await prisma.$queryRaw`
      SELECT je.branch_id, b.name AS branch_name, a.type,
             SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN branches b ON b.id = je.branch_id
      WHERE je.company_id = ${req.companyId}::uuid
        AND je.source_type <> 'CLOSING'
        AND a.type IN ('INCOME', 'COST', 'EXPENSE')
        AND (${from}::timestamp IS NULL OR je.date >= ${from}::timestamp)
        AND (${to}::timestamp IS NULL OR je.date <= ${to}::timestamp)
      GROUP BY je.branch_id, b.name, a.type`

    const byBranch = new Map()
    for (const r of rows) {
      const key = r.branch_id || 'company'
      if (!byBranch.has(key)) {
        byBranch.set(key, {
          branch_id: r.branch_id,
          name: r.branch_name || 'Empresa (sin sucursal)',
          income: 0, costs: 0, expenses: 0, netIncome: 0,
        })
      }
      const row = byBranch.get(key)
      // INCOME es de naturaleza acreedora; COST y EXPENSE, deudora.
      const amount = r.type === 'INCOME'
        ? Number(r.credit) - Number(r.debit)
        : Number(r.debit) - Number(r.credit)
      if (r.type === 'INCOME') row.income = round2(row.income + amount)
      else if (r.type === 'COST') row.costs = round2(row.costs + amount)
      else row.expenses = round2(row.expenses + amount)
    }

    const branches = [...byBranch.values()]
    for (const b of branches) b.netIncome = round2(b.income - b.costs - b.expenses)
    branches.sort((a, b) => b.income - a.income)

    const totals = branches.reduce((t, b) => ({
      income: round2(t.income + b.income),
      costs: round2(t.costs + b.costs),
      expenses: round2(t.expenses + b.expenses),
      netIncome: round2(t.netIncome + b.netIncome),
    }), { income: 0, costs: 0, expenses: 0, netIncome: 0 })

    res.json({ branches, totals })
  } catch (e) { next(e) }
}

/**
 * Reporte de impuestos por mes (estilo declaración SAT): IVA débito de ventas,
 * IVA crédito de compras y tarifa de pequeño contribuyente sobre ventas netas.
 * ponytail: se calcula sobre asientos automáticos (excluye MANUAL/CLOSING);
 * si el contador ajusta impuestos a mano, agregar etiquetas fiscales por línea.
 */
exports.taxesReport = async (req, res, next) => {
  try {
    const year = Number(req.query.year) || DateTime.now().setZone(GT_ZONE).year
    const defaults = await getDefaultAccounts(prisma, req.companyId)
    const { regime, ivaRate, pequenoRate } = await getTaxConfig(prisma, req.companyId)

    const salesIds = new Set([defaults.sales.id, defaults.salesReturns.id])
    const lines = await prisma.journalLine.findMany({
      where: {
        account_id: { in: [defaults.ivaDebit.id, defaults.ivaCredit.id, defaults.pequenoTax.id, ...salesIds] },
        entry: entryScope(req, {
          date: {
            gte: new Date(`${year}-01-01T00:00:00-06:00`),
            lte: new Date(`${year}-12-31T23:59:59.999-06:00`),
          },
          source_type: { notIn: ['MANUAL', 'CLOSING'] },
        }),
      },
      select: { account_id: true, debit: true, credit: true, entry: { select: { date: true } } },
    })

    const months = Array.from({ length: 12 }, (_, i) => (
      { month: i + 1, netSales: 0, ivaDebit: 0, ivaCredit: 0, pequenoTax: 0, toPay: 0 }
    ))
    for (const l of lines) {
      const m = months[DateTime.fromJSDate(l.entry.date, { zone: GT_ZONE }).month - 1]
      const debit = Number(l.debit)
      const credit = Number(l.credit)
      if (l.account_id === defaults.ivaDebit.id) m.ivaDebit = round2(m.ivaDebit + credit - debit)
      else if (l.account_id === defaults.ivaCredit.id) m.ivaCredit = round2(m.ivaCredit + debit - credit)
      else if (l.account_id === defaults.pequenoTax.id) m.pequenoTax = round2(m.pequenoTax + credit - debit)
      else m.netSales = round2(m.netSales + credit - debit)
    }
    const totals = { netSales: 0, ivaDebit: 0, ivaCredit: 0, pequenoTax: 0, toPay: 0 }
    for (const m of months) {
      m.toPay = round2(m.ivaDebit - m.ivaCredit + m.pequenoTax)
      for (const key of Object.keys(totals)) totals[key] = round2(totals[key] + m[key])
    }
    res.json({ year, regime, ivaRate, pequenoRate, months, totals })
  } catch (e) {
    if (e && e.name === 'AccountingError') return res.status(400).json({ error: e.message })
    next(e)
  }
}
