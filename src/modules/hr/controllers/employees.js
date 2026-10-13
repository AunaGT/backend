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

const { prisma, prismaTransaction } = require('../../../models/prisma')
const { requireCompany, requireBranch, targetBranch, branchWhere } = require('../../../middlewares/tenant')
const { uploadHrFile, removeNewHrFiles } = require('../documentStorage')
const { fail, toDate, toMoney, trim, toEnum, toUuid } = require('../domain/validation')
const { createEmployeeWithDocuments, employeeDto } = require('../employeeApplication')
const { DateTime } = require('luxon')
const { employeeExtras, validateSupervisor } = require('../domain/employeeExtras')

const CONTRACT_TYPES = ['INDEFINIDO', 'PLAZO_FIJO', 'POR_OBRA']
const PAY_FREQUENCIES = ['MENSUAL', 'QUINCENAL']
const EMPLOYEE_STATUSES = ['ACTIVO', 'SUSPENDIDO', 'BAJA']
const PAYMENT_METHODS = ['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE']

const EMPLOYEE_INCLUDE = {
  supervisor: { select: { id: true, first_name: true, last_name: true } },
  branch: { select: { id: true, name: true, code: true } },
  user: { select: { id: true, name: true, email: true } },
}
async function lockCurrentEmployee(tx, req, companyId) {
  const branchId = requireBranch(req), id = req.params.id
  const rows = await tx.$queryRaw`SELECT id FROM employees WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`
  if (!rows.length) fail(404, 'Empleado no encontrado en la sucursal activa')
  const current = await tx.employee.findFirst({ where: { id, company_id: companyId, branch_id: branchId } })
  if (!current) fail(404, 'Empleado no encontrado')
  return current
}

/**
 * Valida el usuario a vincular y devuelve su id (o null para desvincular).
 * Tres cosas que la columna sola no garantiza: que el usuario exista, que sea de
 * esta empresa, y que no esté ya tomado por otro empleado. El @unique de la base
 * atrapa la tercera, pero como un P2002 que el llamador confunde con el choque de
 * código — así que acá se revisa antes y se dice de quién es el conflicto.
 */
async function resolveUserLink(db, companyId, raw, { excludeEmployeeId = null } = {}) {
  if (raw == null || String(raw).trim() === '') return null
  const userId = toUuid(raw, 'El usuario seleccionado no es válido')

  const user = await db.user.findFirst({
    where: { id: userId, user_companies: { some: { company_id: companyId } } },
    select: { id: true, name: true },
  })
  if (!user) fail(404, 'El usuario no existe o no pertenece a esta empresa')

  const taken = await db.employee.findFirst({
    where: { user_id: userId, ...(excludeEmployeeId ? { id: { not: excludeEmployeeId } } : {}) },
    select: { first_name: true, last_name: true, code: true },
  })
  if (taken) {
    fail(409, `Ese usuario ya está vinculado a ${taken.first_name} ${taken.last_name} (${taken.code})`)
  }
  return userId
}

/**
 * GET /api/hr/employees/linkable-users — usuarios de la empresa que todavía no
 * tienen empleado. Con ?employee_id= incluye además el que ese empleado ya tiene,
 * para que el selector pueda mostrar su valor actual.
 */
exports.linkableUsers = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const current = req.query.employee_id
      ? await prisma.employee.findFirst({
          where: { id: toUuid(req.query.employee_id, 'Empleado no encontrado'), company_id: companyId },
          select: { user_id: true },
        })
      : null

    const users = await prisma.user.findMany({
      where: {
        user_companies: { some: { company_id: companyId } },
        OR: [
          { employee_record: { is: null } },
          ...(current?.user_id ? [{ id: current.user_id }] : []),
        ],
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    })
    res.json({ items: users })
  } catch (e) { next(e) }
}

/** GET /api/hr/employees?status=&q=&department=&page=&pageSize= */
exports.list = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const positiveInteger = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    const page = positiveInteger(req.query.page, 1)
    const pageSize = Math.min(200, positiveInteger(req.query.pageSize, 50))
    const { status, q, department } = req.query || {}

    const where = { company_id: companyId, ...branchWhere(req) }
    if (status) where.status = toEnum(status, EMPLOYEE_STATUSES, 'El estado del empleado no es válido')
    if (department) where.department = String(department)
    if (req.query.position) where.position = { contains: String(req.query.position).trim().slice(0, 100), mode: 'insensitive' }
    if (req.query.branch_id) where.AND = [{ branch_id: toUuid(req.query.branch_id, 'La sucursal no es válida') }]
    if (q && String(q).trim()) {
      const term = String(q).trim()
      where.OR = [
        { first_name: { contains: term, mode: 'insensitive' } },
        { last_name: { contains: term, mode: 'insensitive' } },
        { code: { contains: term, mode: 'insensitive' } },
        { dpi: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
        { position: { contains: term, mode: 'insensitive' } },
      ]
    }

    const totalItems = await prisma.employee.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    const items = await prisma.employee.findMany({
      where,
      include: EMPLOYEE_INCLUDE,
      orderBy: [{ status: 'asc' }, { last_name: 'asc' }, { first_name: 'asc' }, { id: 'asc' }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    const groups = await prisma.employee.groupBy({ by: ['status'], where: { company_id: companyId, ...branchWhere(req) }, _count: { _all: true } })
    const counts = Object.fromEntries(groups.map(group => [group.status, group._count._all]))
    const timezone = await prisma.systemSetting.findUnique({ where: { company_id_key: { company_id: companyId, key: 'timezone' } }, select: { value: true } })
    const local = DateTime.now().setZone(timezone?.value || 'America/Guatemala')
    const day = DateTime.fromISO((local.isValid ? local : DateTime.now().setZone('America/Guatemala')).toISODate(), { zone: 'UTC' }).toJSDate()
    const licenses = await prisma.attendance.findMany({ where: { company_id: companyId, ...branchWhere(req), work_date: day, status: { in: ['VACACIONES', 'INCAPACIDAD', 'PERMISO'] }, employee: { company_id: companyId, status: 'ACTIVO', ...branchWhere(req) } }, select: { employee_id: true }, distinct: ['employee_id'] })
    const onLeave = licenses.length
    const summary = { total: groups.reduce((sum, group) => sum + group._count._all, 0), active: Math.max(0, (counts.ACTIVO || 0) - onLeave), onLeave, inactive: (counts.SUSPENDIDO || 0) + (counts.BAJA || 0), suspended: counts.SUSPENDIDO || 0, terminated: counts.BAJA || 0 }
    res.set?.('Cache-Control', 'private, no-store')
    res.json({ items: await Promise.all(items.map(employeeDto)), page: safePage, pageSize, totalPages, totalItems, summary })
  } catch (e) { next(e) }
}

/** GET /api/hr/employees/:id */
exports.getById = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const employee = await prisma.employee.findFirst({
      // branchWhere y no requireBranch: la consolidada es lectura legítima.
      where: { id: req.params.id, company_id: companyId, ...branchWhere(req) },
      include: EMPLOYEE_INCLUDE,
    })
    if (!employee) fail(404, 'Empleado no encontrado')
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await employeeDto(employee))
  } catch (e) { next(e) }
}

/**
 * GET /api/hr/employees/me - la ficha del propio usuario.
 *
 * Sin permisos de RRHH a propósito: un cajero no puede ver el expediente de
 * nadie, pero sí el suyo. `user_id` es único, así que hay una ficha o ninguna.
 */
exports.mine = async (req, res, next) => {
  try {
    const employee = await prisma.employee.findFirst({
      where: { user_id: req.user.sub },
      include: EMPLOYEE_INCLUDE,
    })
    if (!employee) fail(404, 'No tenés ficha de empleado')
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await employeeDto(employee))
  } catch (e) { next(e) }
}

/** POST /api/hr/employees */
exports.create = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    let b = req.body || {}, manifest = []
    if (req.is?.('multipart/form-data')) {
      try { b = JSON.parse(req.body.payload); manifest = JSON.parse(req.body.manifest || '[]') }
      catch { fail(400, 'Los datos o el manifiesto documental no son válidos') }
      if (!Array.isArray(manifest) || manifest.length > 20 || manifest.some(m => !m || typeof m.fieldName !== 'string' || typeof m.typeId !== 'string')) fail(400, 'El manifiesto documental no es válido')
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'Los datos del empleado no son válidos')
    const branchId = targetBranch(req, b.branch_id)
    const requestId = req.get?.('Idempotency-Key') || null
    const prior = requestId ? await prisma.employee.findFirst({ where: { company_id: companyId, creation_request_id: toUuid(requestId, 'La clave de reintento no es válida') }, select: { id: true } }) : null
    const rawFiles = req.files || []
    if (manifest.length !== rawFiles.length || new Set(manifest.map(m => m.fieldName)).size !== manifest.length) fail(400, 'Los archivos no coinciden con el manifiesto')
    const files = manifest.map(m => {
      const matches = rawFiles.filter(f => f.fieldname === m.fieldName)
      if (matches.length !== 1) fail(400, 'Cada documento debe corresponder a un único archivo')
      return { typeId: m.typeId, file: matches[0] }
    })

    const data = {
      ...employeeExtras(b),
      supervisor_id: await validateSupervisor(prisma, { company_id: companyId, ...branchWhere(req) }, b.supervisor_id),
      company_id: companyId,
      branch_id: branchId,
      code: trim(b.code, 20),
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
      payment_method: b.payment_method ? toEnum(b.payment_method, PAYMENT_METHODS, 'La forma de pago no es válida') : undefined,
      bank_name: trim(b.bank_name, 100),
      bank_account: trim(b.bank_account, 50),
      user_id: await resolveUserLink(prisma, companyId, b.user_id, { excludeEmployeeId: prior?.id }),
    }

    // Correlativo con reintento: dos altas simultáneas pueden leer el mismo último código.
    const created = await createEmployeeWithDocuments({ companyId, branchId, userId: req.user.sub }, data, files, requestId)

    res.status(201).json(created)
  } catch (e) { next(e) }
}

/** PUT /api/hr/employees/:id */
exports.update = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    const b = req.body || {}
    // La sucursal también acota: el permiso es de empresa (Role) pero el acceso a
    // sucursal es aparte (UserBranch), así que sin esto alguien reasignado a otra
    // sucursal seguiría pudiendo tocar registros de la anterior.
    const current = await prisma.employee.findFirst({
      where: { id: req.params.id, company_id: companyId, branch_id: requireBranch(req) },
    })
    if (!current) fail(404, 'Empleado no encontrado')

    const data = employeeExtras(b)
    if (b.supervisor_id !== undefined) data.supervisor_id = await validateSupervisor(prisma, { company_id: companyId, ...branchWhere(req) }, b.supervisor_id, current.id)
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
    if (b.payment_method !== undefined) setIf('payment_method', toEnum(b.payment_method, PAYMENT_METHODS, 'La forma de pago no es válida'))
    if (b.bank_name !== undefined) setIf('bank_name', trim(b.bank_name, 100))
    if (b.bank_account !== undefined) setIf('bank_account', trim(b.bank_account, 50))
    if (b.status !== undefined) setIf('status', toEnum(b.status, EMPLOYEE_STATUSES, 'El estado del empleado no es válido'))
    if (b.user_id !== undefined) {
      setIf('user_id', await resolveUserLink(prisma, companyId, b.user_id, { excludeEmployeeId: current.id }))
    }
    if (b.branch_id !== undefined) setIf('branch_id', targetBranch(req, b.branch_id))

    const updated = await (prismaTransaction || prisma).$transaction(async tx => {
      const fresh = await lockCurrentEmployee(tx, req, companyId)
      const employee = await tx.employee.update({ where: { id: current.id }, data, include: EMPLOYEE_INCLUDE })
      const changes = Object.fromEntries(Object.keys(data).filter(key => String(fresh[key] ?? '') !== String(employee[key] ?? '')).map(key => [key, { before: fresh[key] ?? null, after: employee[key] ?? null }]))
      if (Object.keys(changes).length) await tx.employeeHistory.create({ data: { company_id: companyId, employee_id: current.id, actor_id: req.user.sub, event: 'EMPLOYEE_UPDATED', changes: JSON.parse(JSON.stringify(changes)) } })
      return employee
    }, { maxWait: 10000, timeout: 20000 })
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await employeeDto(updated))
  } catch (e) { next(e) }
}

/** POST /api/hr/employees/:id/photo */
exports.uploadPhoto = async (req, res, next) => {
  let newPath
  try {
    const companyId = requireCompany(req)
    const current = await prisma.employee.findFirst({
      where: { id: req.params.id, company_id: companyId, branch_id: requireBranch(req) },
    })
    if (!current) fail(404, 'Empleado no encontrado')
    if (!req.file) fail(400, 'No se proporcionó ningún archivo')

    if (!['image/png', 'image/jpeg'].includes(req.file.mimetype)) fail(400, 'La fotografía debe ser JPEG o PNG')
    const object = await uploadHrFile({ companyId, employeeId: current.id, file: req.file })
    newPath = object.path

    const updated = await (prismaTransaction || prisma).$transaction(async tx => {
      await lockCurrentEmployee(tx, req, companyId)
      const employee = await tx.employee.update({
      where: { id: current.id },
      data: { photo_storage_path: newPath },
      include: EMPLOYEE_INCLUDE,
      })
      await tx.employeeHistory.create({ data: { company_id: companyId, employee_id: current.id, actor_id: req.user.sub, event: 'PHOTO_UPDATED', changes: {} } })
      return employee
    }, { maxWait: 10000, timeout: 20000 })
    newPath = null
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await employeeDto(updated))
  } catch (e) {
    if (newPath) { try { await removeNewHrFiles([newPath]) } catch { e.message += '. No se pudo limpiar la carga incompleta' } }
    next(e)
  }
}

/**
 * DELETE /api/hr/employees/:id — baja lógica.
 * Body opcional: { termination_date }. Sin ella se usa hoy.
 */
exports.remove = async (req, res, next) => {
  try {
    const companyId = requireCompany(req)
    // La sucursal también acota: el permiso es de empresa (Role) pero el acceso a
    // sucursal es aparte (UserBranch), así que sin esto alguien reasignado a otra
    // sucursal seguiría pudiendo tocar registros de la anterior.
    const current = await prisma.employee.findFirst({
      where: { id: req.params.id, company_id: companyId, branch_id: requireBranch(req) },
    })
    if (!current) fail(404, 'Empleado no encontrado')
    if (current.status === 'BAJA') fail(409, 'El empleado ya está dado de baja')

    const updated = await (prismaTransaction || prisma).$transaction(async tx => {
      const fresh = await lockCurrentEmployee(tx, req, companyId)
      if (fresh.status === 'BAJA') fail(409, 'El empleado ya está dado de baja')
      const employee = await tx.employee.update({
      where: { id: current.id },
      data: {
        status: 'BAJA',
        termination_date: toDate(req.body?.termination_date, 'La fecha de retiro') || new Date(),
      },
      include: EMPLOYEE_INCLUDE,
      })
      await tx.employeeHistory.create({ data: { company_id: companyId, employee_id: current.id, actor_id: req.user.sub, event: 'EMPLOYEE_TERMINATED', changes: { status: { before: fresh.status, after: 'BAJA' }, termination_date: { before: fresh.termination_date?.toISOString() || null, after: employee.termination_date.toISOString() } } } })
      return employee
    }, { maxWait: 10000, timeout: 20000 })
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await employeeDto(updated))
  } catch (e) { next(e) }
}

module.exports.CONTRACT_TYPES = CONTRACT_TYPES
module.exports.PAY_FREQUENCIES = PAY_FREQUENCIES
module.exports.EMPLOYEE_STATUSES = EMPLOYEE_STATUSES
