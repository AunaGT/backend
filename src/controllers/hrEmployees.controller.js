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
 * Expediente laboral. La baja es lógica: un empleado con recibos emitidos no
 * se borra nunca, se marca BAJA con su fecha de retiro.
 */

const { prisma } = require('../models/prisma')
const { requireCompany, targetBranch, branchWhere } = require('../middlewares/tenant')

/** Error de negocio con status HTTP; lo traduce el error handler global. */
function fail(status, message) {
  const err = new Error(message)
  err.status = status
  throw err
}

/**
 * 'yyyy-mm-dd' se interpreta al mediodía de Guatemala, no a medianoche UTC:
 * de lo contrario una fecha de ingreso cae al día anterior en la base.
 */
function toDate(value, field, { required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) fail(400, `${field} es obligatorio`)
    return null
  }
  const raw = String(value).trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00-06:00`) : new Date(raw)
  if (Number.isNaN(date.getTime())) fail(400, `${field} no es una fecha válida`)
  return date
}

function toMoney(value, field, { required = false, min = 0 } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) fail(400, `${field} es obligatorio`)
    return null
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) fail(400, `${field} debe ser un número mayor o igual a ${min}`)
  return Math.round(n * 100) / 100
}

const trim = (v, max) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max))

const CONTRACT_TYPES = ['INDEFINIDO', 'PLAZO_FIJO', 'POR_OBRA']
const PAY_FREQUENCIES = ['MENSUAL', 'QUINCENAL']
const EMPLOYEE_STATUSES = ['ACTIVO', 'SUSPENDIDO', 'BAJA']

/** Valida contra la lista de valores del enum; null, '' o basura dan 400 en español. */
function toEnum(value, allowed, message) {
  const raw = value == null ? '' : String(value).trim().toUpperCase()
  if (!allowed.includes(raw)) fail(400, message)
  return raw
}

const EMPLOYEE_INCLUDE = {
  branch: { select: { id: true, name: true, code: true } },
  user: { select: { id: true, name: true, email: true } },
}

/** Correlativo EMP-0001 por empresa. Reintenta el llamador si choca el unique. */
async function nextEmployeeCode(tx, companyId) {
  const last = await tx.employee.findFirst({
    where: { company_id: companyId, code: { startsWith: 'EMP-' } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const n = last ? Number(last.code.slice(4)) : 0
  return `EMP-${String((Number.isFinite(n) ? n : 0) + 1).padStart(4, '0')}`
}

/** GET /api/hr/employees?status=&q=&department=&page=&pageSize= */
exports.list = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)))
    const { status, q, department } = req.query || {}

    const where = { company_id: companyId, ...branchWhere(req) }
    if (status) where.status = toEnum(status, EMPLOYEE_STATUSES, 'El estado del empleado no es válido')
    if (department) where.department = String(department)
    if (q && String(q).trim()) {
      const term = String(q).trim()
      where.OR = [
        { first_name: { contains: term, mode: 'insensitive' } },
        { last_name: { contains: term, mode: 'insensitive' } },
        { code: { contains: term, mode: 'insensitive' } },
        { dpi: { contains: term } },
      ]
    }

    const totalItems = await prisma.employee.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    const items = await prisma.employee.findMany({
      where,
      include: EMPLOYEE_INCLUDE,
      orderBy: [{ status: 'asc' }, { last_name: 'asc' }, { first_name: 'asc' }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    res.json({ items, page: safePage, pageSize, totalPages, totalItems })
  } catch (e) { next(e) }
}

/** GET /api/hr/employees/:id */
exports.getById = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, company_id: companyId },
      include: EMPLOYEE_INCLUDE,
    })
    if (!employee) fail(404, 'Empleado no encontrado')
    res.json(employee)
  } catch (e) { next(e) }
}

/** POST /api/hr/employees */
exports.create = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    const branchId = targetBranch(req, b.branch_id)

    const data = {
      company_id: companyId,
      branch_id: branchId,
      first_name: trim(b.first_name, 100) || fail(400, 'El nombre es obligatorio'),
      last_name: trim(b.last_name, 100) || fail(400, 'El apellido es obligatorio'),
      dpi: trim(b.dpi, 20),
      nit: trim(b.nit, 20),
      igss_number: trim(b.igss_number, 20),
      birth_date: toDate(b.birth_date, 'La fecha de nacimiento'),
      phone: trim(b.phone, 50),
      email: trim(b.email, 150),
      address: trim(b.address, 1000),
      photo_url: trim(b.photo_url, 500),
      position: trim(b.position, 100),
      department: trim(b.department, 100),
      hire_date: toDate(b.hire_date, 'La fecha de ingreso', { required: true }),
      contract_type: b.contract_type ? toEnum(b.contract_type, CONTRACT_TYPES, 'El tipo de contrato no es válido') : undefined,
      pay_frequency: b.pay_frequency ? toEnum(b.pay_frequency, PAY_FREQUENCIES, 'La frecuencia de pago no es válida') : undefined,
      base_salary: toMoney(b.base_salary, 'El sueldo base', { required: true }),
      bonificacion_incentivo: toMoney(b.bonificacion_incentivo, 'La bonificación incentivo') ?? 250,
      bank_account: trim(b.bank_account, 50),
      user_id: b.user_id ? String(b.user_id) : null,
    }

    // Correlativo con reintento: dos altas simultáneas pueden leer el mismo último código.
    let created = null
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const code = trim(b.code, 20) || (await nextEmployeeCode(prisma, companyId))
      try {
        created = await prisma.employee.create({ data: { ...data, code }, include: EMPLOYEE_INCLUDE })
      } catch (err) {
        if (err.code !== 'P2002') throw err
        if (trim(b.code, 20)) fail(409, `Ya existe un empleado con el código ${code}`)
      }
    }
    if (!created) fail(409, 'No se pudo asignar un código de empleado, intenta de nuevo')

    res.status(201).json(created)
  } catch (e) { next(e) }
}

/** PUT /api/hr/employees/:id */
exports.update = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    const current = await prisma.employee.findFirst({ where: { id: req.params.id, company_id: companyId } })
    if (!current) fail(404, 'Empleado no encontrado')

    const data = {}
    const setIf = (key, value) => { if (value !== undefined) data[key] = value }
    if (b.first_name !== undefined) setIf('first_name', trim(b.first_name, 100) || fail(400, 'El nombre es obligatorio'))
    if (b.last_name !== undefined) setIf('last_name', trim(b.last_name, 100) || fail(400, 'El apellido es obligatorio'))
    if (b.dpi !== undefined) setIf('dpi', trim(b.dpi, 20))
    if (b.nit !== undefined) setIf('nit', trim(b.nit, 20))
    if (b.igss_number !== undefined) setIf('igss_number', trim(b.igss_number, 20))
    if (b.birth_date !== undefined) setIf('birth_date', toDate(b.birth_date, 'La fecha de nacimiento'))
    if (b.phone !== undefined) setIf('phone', trim(b.phone, 50))
    if (b.email !== undefined) setIf('email', trim(b.email, 150))
    if (b.address !== undefined) setIf('address', trim(b.address, 1000))
    if (b.photo_url !== undefined) setIf('photo_url', trim(b.photo_url, 500))
    if (b.position !== undefined) setIf('position', trim(b.position, 100))
    if (b.department !== undefined) setIf('department', trim(b.department, 100))
    if (b.hire_date !== undefined) setIf('hire_date', toDate(b.hire_date, 'La fecha de ingreso', { required: true }))
    if (b.termination_date !== undefined) setIf('termination_date', toDate(b.termination_date, 'La fecha de retiro'))
    if (b.contract_type !== undefined) setIf('contract_type', toEnum(b.contract_type, CONTRACT_TYPES, 'El tipo de contrato no es válido'))
    if (b.pay_frequency !== undefined) setIf('pay_frequency', toEnum(b.pay_frequency, PAY_FREQUENCIES, 'La frecuencia de pago no es válida'))
    if (b.base_salary !== undefined) setIf('base_salary', toMoney(b.base_salary, 'El sueldo base', { required: true }))
    if (b.bonificacion_incentivo !== undefined) setIf('bonificacion_incentivo', toMoney(b.bonificacion_incentivo, 'La bonificación incentivo', { required: true }))
    if (b.bank_account !== undefined) setIf('bank_account', trim(b.bank_account, 50))
    if (b.status !== undefined) setIf('status', toEnum(b.status, EMPLOYEE_STATUSES, 'El estado del empleado no es válido'))
    if (b.user_id !== undefined) setIf('user_id', b.user_id ? String(b.user_id) : null)
    if (b.branch_id !== undefined) setIf('branch_id', targetBranch(req, b.branch_id))

    const updated = await prisma.employee.update({
      where: { id: current.id },
      data,
      include: EMPLOYEE_INCLUDE,
    })
    res.json(updated)
  } catch (e) { next(e) }
}

/**
 * DELETE /api/hr/employees/:id — baja lógica.
 * Body opcional: { termination_date }. Sin ella se usa hoy.
 */
exports.remove = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const current = await prisma.employee.findFirst({ where: { id: req.params.id, company_id: companyId } })
    if (!current) fail(404, 'Empleado no encontrado')
    if (current.status === 'BAJA') fail(409, 'El empleado ya está dado de baja')

    const updated = await prisma.employee.update({
      where: { id: current.id },
      data: {
        status: 'BAJA',
        termination_date: toDate(req.body?.termination_date, 'La fecha de retiro') || new Date(),
      },
      include: EMPLOYEE_INCLUDE,
    })
    res.json(updated)
  } catch (e) { next(e) }
}

module.exports.fail = fail
module.exports.toDate = toDate
module.exports.toMoney = toMoney
module.exports.trim = trim
module.exports.toEnum = toEnum
module.exports.CONTRACT_TYPES = CONTRACT_TYPES
module.exports.PAY_FREQUENCIES = PAY_FREQUENCIES
module.exports.EMPLOYEE_STATUSES = EMPLOYEE_STATUSES
