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
 * Asistencia diaria. Es un registro informativo: no descuenta días del sueldo
 * (el sueldo mensual es fijo). Lo único que le aporta a la nómina son las horas
 * extra del período, que la corrida usa como valor sugerido y editable.
 */

const { prisma } = require('../models/prisma')
const { requireCompany, requireBranch, targetBranch, branchWhere } = require('../middlewares/tenant')
const { fail, toDate, trim, toEnum } = require('./hrEmployees.controller')

const ATTENDANCE_STATUSES = ['PRESENTE', 'TARDE', 'AUSENTE', 'VACACIONES', 'INCAPACIDAD', 'PERMISO', 'ASUETO']

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function toTime(value, field) {
  const raw = trim(value, 5)
  if (raw == null) return null
  if (!HHMM.test(raw)) fail(400, `${field} debe tener el formato HH:MM`)
  return raw
}

function toHours(value, field) {
  if (value == null || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 24) fail(400, `${field} debe estar entre 0 y 24`)
  return Math.round(n * 100) / 100
}

function toStatus(value) {
  if (value == null || String(value).trim() === '') return undefined
  return toEnum(value, ATTENDANCE_STATUSES, `Estado de asistencia inválido: ${String(value).toUpperCase()}`)
}

/** El empleado tiene que ser de la empresa del request. */
async function requireEmployee(companyId, employeeId) {
  if (!employeeId) fail(400, 'El empleado es obligatorio')
  const employee = await prisma.employee.findFirst({
    where: { id: String(employeeId), company_id: companyId },
    select: { id: true, branch_id: true },
  })
  if (!employee) fail(404, 'Empleado no encontrado')
  return employee
}

/** GET /api/hr/attendance?from=&to=&employee_id= */
exports.list = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const { from, to, employee_id } = req.query || {}
    const where = { company_id: companyId, ...branchWhere(req) }
    const gte = toDate(from, 'La fecha inicial')
    const lte = toDate(to, 'La fecha final')
    if (gte || lte) where.work_date = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) }
    if (employee_id) where.employee_id = String(employee_id)

    const items = await prisma.attendance.findMany({
      where,
      include: { employee: { select: { id: true, code: true, first_name: true, last_name: true } } },
      orderBy: [{ work_date: 'asc' }, { employee_id: 'asc' }],
      take: 5000, // ponytail: un mes de ~150 empleados cabe de sobra; paginar si algún día no
    })
    res.json({ items })
  } catch (e) { next(e) }
}

/**
 * POST /api/hr/attendance — upsert por (employee_id, work_date).
 * Marcar dos veces el mismo día corrige la marca, no crea una segunda.
 *
 * Solo se tocan los campos que vinieron en el body: el diálogo de horas extra
 * del frontend manda { employee_id, work_date, overtime_hours, status } sin
 * check_in/check_out, y una corrección parcial no debe borrar la entrada y
 * salida ya capturadas. Omitir un campo significa "no lo toques"; mandarlo
 * explícito en null significa "bórralo" — mismo contrato que
 * hrEmployees.controller.update.
 */
exports.upsert = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    const employee = await requireEmployee(companyId, b.employee_id)
    const workDate = toDate(b.work_date, 'La fecha', { required: true })
    const branchId = targetBranch(req, b.branch_id || employee.branch_id)

    const supplied = {}
    const setIf = (key, value) => { if (value !== undefined) supplied[key] = value }
    if (b.check_in !== undefined) setIf('check_in', toTime(b.check_in, 'La hora de entrada'))
    if (b.check_out !== undefined) setIf('check_out', toTime(b.check_out, 'La hora de salida'))
    if (b.hours !== undefined) setIf('hours', toHours(b.hours, 'Las horas trabajadas'))
    if (b.overtime_hours !== undefined) setIf('overtime_hours', toHours(b.overtime_hours, 'Las horas extra') ?? 0)
    if (b.status !== undefined) setIf('status', toStatus(b.status))
    if (b.notes !== undefined) setIf('notes', trim(b.notes, 1000))

    // Defaults solo para una marca nueva; una corrección parcial no los aplica.
    const defaults = { overtime_hours: 0, status: 'PRESENTE' }

    const saved = await prisma.attendance.upsert({
      where: { employee_id_work_date: { employee_id: employee.id, work_date: workDate } },
      update: supplied,
      create: { company_id: companyId, branch_id: branchId, employee_id: employee.id, work_date: workDate, ...defaults, ...supplied },
      include: { employee: { select: { id: true, code: true, first_name: true, last_name: true } } },
    })
    res.status(201).json(saved)
  } catch (e) { next(e) }
}

/**
 * POST /api/hr/attendance/bulk — marca un mismo día para varios empleados.
 * Body: { work_date, status?, overtime_hours?, employee_ids: [] }
 *
 * Igual que `upsert`, un bulk que solo trae `status` no debe borrar horas
 * extra ya registradas ese día para alguno de los empleados.
 */
exports.bulk = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    const workDate = toDate(b.work_date, 'La fecha', { required: true })
    const ids = Array.isArray(b.employee_ids) ? [...new Set(b.employee_ids.map(String))] : []
    if (ids.length === 0) fail(400, 'Selecciona al menos un empleado')

    const employees = await prisma.employee.findMany({
      where: { id: { in: ids }, company_id: companyId },
      select: { id: true, branch_id: true },
    })
    if (employees.length !== ids.length) fail(404, 'Uno o más empleados no existen en esta empresa')

    // Resuelve el acceso de sucursal de todos antes de escribir nada: si uno
    // solo no es alcanzable, la llamada completa falla sin dejar cambios a medias.
    const branchByEmployee = new Map(employees.map((e) => [e.id, targetBranch(req, e.branch_id)]))

    const status = toStatus(b.status) ?? 'PRESENTE'
    const supplied = {}
    if (b.overtime_hours !== undefined) supplied.overtime_hours = toHours(b.overtime_hours, 'Las horas extra') ?? 0
    if (b.notes !== undefined) supplied.notes = trim(b.notes, 1000)

    let saved = 0
    for (const employee of employees) {
      await prisma.attendance.upsert({
        where: { employee_id_work_date: { employee_id: employee.id, work_date: workDate } },
        update: { status, ...supplied },
        create: {
          company_id: companyId,
          branch_id: branchByEmployee.get(employee.id),
          employee_id: employee.id,
          work_date: workDate,
          status,
          overtime_hours: 0,
          notes: null,
          ...supplied,
        },
      })
      saved += 1
    }
    res.status(201).json({ saved })
  } catch (e) { next(e) }
}

/** DELETE /api/hr/attendance/:id */
exports.remove = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    // La sucursal también acota: el permiso es de empresa (Role) pero el acceso a
    // sucursal es aparte (UserBranch), así que sin esto alguien reasignado a otra
    // sucursal seguiría pudiendo tocar registros de la anterior.
    const current = await prisma.attendance.findFirst({
      where: { id: req.params.id, company_id: companyId, branch_id: requireBranch(req) },
    })
    if (!current) fail(404, 'Marca de asistencia no encontrada')
    await prisma.attendance.delete({ where: { id: current.id } })
    res.json({ ok: true })
  } catch (e) { next(e) }
}
