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
 * Corridas de planilla: generación y consulta. Las transiciones de estado
 * (confirmar, pagar, anular) viven en payrollTransitions.controller.js, que es
 * donde está la concurrencia y la contabilidad.
 */

const { prisma, prismaTransaction } = require('../models/prisma')
const { requireCompany, targetBranch, branchWhere } = require('../middlewares/tenant')
const { fail, toDate, trim, toEnum, toUuid } = require('./hrEmployees.controller')
const { getPayrollRates } = require('../services/payroll/rates')
const { buildPayslip } = require('../services/payroll/build')
const { round2 } = require('../services/payroll/calc')

const TX_OPTIONS = { maxWait: 10000, timeout: 30000 }
const PAYROLL_TYPES = ['ORDINARIA', 'AGUINALDO', 'BONO14']
const PAYROLL_STATUSES = ['BORRADOR', 'CONFIRMADA', 'PAGADA', 'ANULADA']

// Serializa la numeración por empresa dentro de la transacción, igual que
// nextEntryNumber para los asientos. Un reintento sobre P2002 no sirve aquí:
// Postgres aborta la transacción entera al primer error y el siguiente query
// muere con 25P02, no con P2002.
const RUN_LOCK_KEY = 910005

const RUN_INCLUDE = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true } },
  confirmedBy: { select: { id: true, name: true } },
  payslips: {
    include: {
      employee: { select: { id: true, code: true, first_name: true, last_name: true, position: true, igss_number: true } },
      lines: { orderBy: { sort_order: 'asc' } },
    },
    orderBy: { employee: { last_name: 'asc' } },
  },
}

/** Correlativo NOM-2026-08-001 por empresa y mes. */
async function nextRunCode(tx, companyId, payDate) {
  // Los casts son obligatorios: la forma de dos argumentos es (int, int) y
  // Prisma manda el número como bigint y el hash como integer.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_KEY}::int, hashtext(${companyId})::int)`
  const prefix = `NOM-${payDate.getUTCFullYear()}-${String(payDate.getUTCMonth() + 1).padStart(2, '0')}-`
  const last = await tx.payrollRun.findFirst({
    where: { company_id: companyId, code: { startsWith: prefix } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const n = last ? Number(last.code.slice(prefix.length)) : 0
  return `${prefix}${String((Number.isFinite(n) ? n : 0) + 1).padStart(3, '0')}`
}

/**
 * Acumulados del año por empleado, solo de corridas CONFIRMADA o PAGADA: la
 * proyección de ISR se apoya en ellos. `taxable` sale de `payslips.isr_base`
 * (que ya trae el excedente gravable del aguinaldo); IGSS e ISR retenidos
 * salen de las líneas.
 */
async function ytdTotals(tx, run, employeeIds) {
  const year = run.pay_date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const yearEnd = new Date(Date.UTC(year, 11, 31))

  const bases = await tx.payslip.groupBy({
    by: ['employee_id'],
    where: {
      employee_id: { in: employeeIds },
      run_id: { not: run.id },
      run: { company_id: run.company_id, status: { in: ['CONFIRMADA', 'PAGADA'] }, pay_date: { gte: yearStart, lte: yearEnd } },
    },
    _sum: { isr_base: true },
  })

  const rows = await tx.$queryRaw`
    SELECT ps.employee_id::text AS employee_id,
           COALESCE(SUM(CASE WHEN pl.concept = 'IGSS_LABORAL' THEN pl.amount ELSE 0 END), 0) AS igss,
           COALESCE(SUM(CASE WHEN pl.concept = 'ISR_RETENIDO' THEN pl.amount ELSE 0 END), 0) AS isr
    FROM payslip_lines pl
    JOIN payslips ps ON ps.id = pl.payslip_id
    JOIN payroll_runs r ON r.id = ps.run_id
    WHERE r.company_id = ${run.company_id}::uuid
      AND r.id <> ${run.id}::uuid
      AND r.status IN ('CONFIRMADA', 'PAGADA')
      AND r.pay_date BETWEEN ${yearStart}::date AND ${yearEnd}::date
    GROUP BY ps.employee_id
  `

  const out = new Map()
  const at = (id) => {
    if (!out.has(id)) out.set(id, { taxable: 0, igss: 0, isr: 0 })
    return out.get(id)
  }
  for (const b of bases) at(b.employee_id).taxable = Number(b._sum.isr_base || 0)
  for (const r of rows) {
    const acc = at(r.employee_id)
    acc.igss = Number(r.igss)
    acc.isr = Number(r.isr)
  }
  return out
}

/**
 * Borra los recibos de la corrida y los vuelve a calcular. `overrides` es
 * `{ [employee_id]: horasExtra }` y pisa lo sugerido por la asistencia.
 */
async function generatePayslips(tx, run, overrides = {}) {
  await tx.payslip.deleteMany({ where: { run_id: run.id } }) // las líneas caen en cascada

  const rates = await getPayrollRates(tx, run.company_id)

  const employees = await tx.employee.findMany({
    where: {
      company_id: run.company_id,
      branch_id: run.branch_id,
      hire_date: { lte: run.period_end },
      OR: [
        { status: { in: ['ACTIVO', 'SUSPENDIDO'] } },
        // Quien se fue a mitad del período todavía cobra su parte
        { status: 'BAJA', termination_date: { gte: run.period_start } },
      ],
    },
    orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }],
  })
  if (employees.length === 0) fail(400, 'La planilla no tiene empleados activos en el período')

  const ids = employees.map((e) => e.id)

  const overtimeRows = await tx.attendance.groupBy({
    by: ['employee_id'],
    where: { employee_id: { in: ids }, work_date: { gte: run.period_start, lte: run.period_end } },
    _sum: { overtime_hours: true },
  })
  const overtimeByEmployee = new Map(overtimeRows.map((r) => [r.employee_id, Number(r._sum.overtime_hours || 0)]))

  // Solo la ordinaria descuenta anticipos; aguinaldo y bono 14 salen limpios.
  const advances = run.type === 'ORDINARIA'
    ? await tx.employeeAdvance.findMany({
        where: { employee_id: { in: ids }, status: 'PENDIENTE', balance: { gt: 0 } },
        orderBy: { date: 'asc' },
      })
    : []
  const advancesByEmployee = new Map()
  for (const a of advances) {
    const list = advancesByEmployee.get(a.employee_id) || []
    list.push({ id: a.id, installment: Number(a.installment), balance: Number(a.balance) })
    advancesByEmployee.set(a.employee_id, list)
  }

  const ytdByEmployee = await ytdTotals(tx, run, ids)

  let earnings = 0
  let deductions = 0
  let employerCostTotal = 0

  for (const employee of employees) {
    const override = overrides[employee.id]
    const slip = buildPayslip({
      employee,
      run,
      rates,
      overtimeHours: override != null && override !== '' ? Number(override) : (overtimeByEmployee.get(employee.id) ?? 0),
      advances: advancesByEmployee.get(employee.id) || [],
      ytd: ytdByEmployee.get(employee.id) || { taxable: 0, igss: 0, isr: 0 },
    })
    if (slip.lines.length === 0) continue // no le corresponde nada en este período

    await tx.payslip.create({
      data: {
        run_id: run.id,
        employee_id: employee.id,
        base_salary: Number(employee.base_salary),
        days_worked: slip.days_worked,
        igss_base: slip.igss_base,
        isr_base: slip.isr_base,
        total_earnings: slip.total_earnings,
        total_deductions: slip.total_deductions,
        net_pay: slip.net_pay,
        employer_cost: slip.employer_cost,
        lines: { create: slip.lines },
      },
    })

    earnings = round2(earnings + slip.total_earnings)
    deductions = round2(deductions + slip.total_deductions)
    employerCostTotal = round2(employerCostTotal + slip.employer_cost)
  }

  return tx.payrollRun.update({
    where: { id: run.id },
    data: {
      total_earnings: earnings,
      total_deductions: deductions,
      total_net: round2(earnings - deductions),
      total_employer_cost: employerCostTotal,
    },
  })
}

/** Período por defecto de aguinaldo (1-dic → 30-nov) y bono 14 (1-jul → 30-jun). */
function defaultBonusPeriod(type, payDate) {
  const year = payDate.getUTCFullYear()
  if (type === 'AGUINALDO') {
    return { start: new Date(Date.UTC(year - 1, 11, 1)), end: new Date(Date.UTC(year, 10, 30)) }
  }
  return { start: new Date(Date.UTC(year - 1, 6, 1)), end: new Date(Date.UTC(year, 5, 30)) }
}

/** GET /api/payroll/runs?year=&type=&status= */
exports.list = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const { year, type, status } = req.query || {}
    const where = { company_id: companyId, ...branchWhere(req) }
    if (type) where.type = toEnum(type, PAYROLL_TYPES, 'El tipo de planilla no es válido')
    if (status) where.status = toEnum(status, PAYROLL_STATUSES, 'El estado de planilla no es válido')
    if (year) {
      const y = Number(year)
      if (!Number.isInteger(y)) fail(400, 'El año no es válido')
      where.pay_date = { gte: new Date(Date.UTC(y, 0, 1)), lte: new Date(Date.UTC(y, 11, 31)) }
    }

    const items = await prisma.payrollRun.findMany({
      where,
      include: { branch: { select: { id: true, name: true } }, _count: { select: { payslips: true } } },
      orderBy: { pay_date: 'desc' },
      take: 500,
    })
    res.json({ items })
  } catch (e) { next(e) }
}

/** GET /api/payroll/runs/:id */
exports.getById = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const id = toUuid(req.params.id, 'Planilla no encontrada')
    const run = await prisma.payrollRun.findFirst({
      where: { id, company_id: companyId },
      include: RUN_INCLUDE,
    })
    if (!run) fail(404, 'Planilla no encontrada')
    res.json(run)
  } catch (e) { next(e) }
}

/** GET /api/payroll/runs/:id/payslips/:payslipId */
exports.getPayslip = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const runId = toUuid(req.params.id, 'Recibo no encontrado')
    const payslipId = toUuid(req.params.payslipId, 'Recibo no encontrado')
    const payslip = await prisma.payslip.findFirst({
      where: { id: payslipId, run_id: runId, run: { company_id: companyId } },
      include: {
        employee: true,
        lines: { orderBy: { sort_order: 'asc' } },
        run: { select: { id: true, code: true, name: true, type: true, period_start: true, period_end: true, pay_date: true, status: true } },
      },
    })
    if (!payslip) fail(404, 'Recibo no encontrado')
    res.json(payslip)
  } catch (e) { next(e) }
}

/** POST /api/payroll/runs — genera la corrida en BORRADOR */
exports.create = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    const branchId = targetBranch(req, b.branch_id)

    const type = String(b.type || 'ORDINARIA').toUpperCase()
    if (!PAYROLL_TYPES.includes(type)) fail(400, `Tipo de planilla inválido: ${type}`)

    const payDate = toDate(b.pay_date, 'La fecha de pago', { required: true })
    let periodStart = toDate(b.period_start, 'El inicio del período')
    let periodEnd = toDate(b.period_end, 'El fin del período')
    if (!periodStart || !periodEnd) {
      if (type === 'ORDINARIA') fail(400, 'El período de la planilla es obligatorio')
      const fallback = defaultBonusPeriod(type, payDate)
      periodStart = periodStart || fallback.start
      periodEnd = periodEnd || fallback.end
    }
    if (periodEnd < periodStart) fail(400, 'El fin del período no puede ser anterior al inicio')

    const overrides = (b.overtime && typeof b.overtime === 'object') ? b.overtime : {}

    const created = await prismaTransaction.$transaction(async (tx) => {
      const code = await nextRunCode(tx, companyId, payDate)
      const run = await tx.payrollRun.create({
        data: {
          company_id: companyId,
          branch_id: branchId,
          code,
          name: trim(b.name, 150) || `Planilla ${code}`,
          type,
          period_start: periodStart,
          period_end: periodEnd,
          pay_date: payDate,
          notes: trim(b.notes, 1000),
          created_by: req.user?.sub || null,
        },
      })

      await generatePayslips(tx, run, overrides)
      return tx.payrollRun.findUnique({ where: { id: run.id }, include: RUN_INCLUDE })
    }, TX_OPTIONS)

    res.status(201).json(created)
  } catch (e) { next(e) }
}

/** POST /api/payroll/runs/:id/recalculate — solo en BORRADOR */
exports.recalculate = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const overrides = (req.body?.overtime && typeof req.body.overtime === 'object') ? req.body.overtime : {}

    const id = toUuid(req.params.id, 'Planilla no encontrada')
    const updated = await prismaTransaction.$transaction(async (tx) => {
      const run = await tx.payrollRun.findFirst({ where: { id, company_id: companyId } })
      if (!run) fail(404, 'Planilla no encontrada')
      if (run.status !== 'BORRADOR') fail(409, 'Solo se puede recalcular una planilla en borrador')
      await generatePayslips(tx, run, overrides)
      return tx.payrollRun.findUnique({ where: { id: run.id }, include: RUN_INCLUDE })
    }, TX_OPTIONS)

    res.json(updated)
  } catch (e) { next(e) }
}

/** DELETE /api/payroll/runs/:id — solo en BORRADOR */
exports.remove = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const id = toUuid(req.params.id, 'Planilla no encontrada')
    const run = await prisma.payrollRun.findFirst({ where: { id, company_id: companyId } })
    if (!run) fail(404, 'Planilla no encontrada')
    if (run.status !== 'BORRADOR') fail(409, 'Solo se puede eliminar una planilla en borrador')
    // Reclamo atómico: si alguien la confirmó entre la lectura y el borrado, no se borra.
    const claim = await prisma.payrollRun.deleteMany({ where: { id: run.id, status: 'BORRADOR' } })
    if (claim.count !== 1) fail(409, 'La planilla cambió de estado, recarga la página')
    res.json({ ok: true })
  } catch (e) { next(e) }
}

module.exports.generatePayslips = generatePayslips
module.exports.nextRunCode = nextRunCode
module.exports.RUN_INCLUDE = RUN_INCLUDE
module.exports.TX_OPTIONS = TX_OPTIONS
