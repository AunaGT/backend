const { prisma } = require('../../../models/prisma')
const { requireCompany, branchWhere, hasPerm } = require('../../../middlewares/tenant')
const { fail, toUuid } = require('../domain/validation')
const PURPOSES = { attendance: ['hr.attendance.view', 'hr.attendance.manage'], advance: ['hr.advances.manage'], supervisor: ['hr.employees.create', 'hr.employees.edit'] }
exports.list = async (req, res, next) => {
  try {
    const company_id = requireCompany(req), purpose = req.query.purpose
    if (!Object.hasOwn(PURPOSES, purpose)) fail(400, 'Indica un propósito válido para buscar empleados')
    if (!PURPOSES[purpose].some(code => hasPerm(req.user, code))) fail(403, 'Sin permiso para esta búsqueda de empleados')
    const integer = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    const pageSize = Math.min(32, integer(req.query.pageSize, 10))
    const where = { company_id, ...branchWhere(req), ...(purpose !== 'attendance' ? { status: 'ACTIVO' } : {}) }
    if (req.query.excludeId && purpose === 'supervisor') where.id = { not: toUuid(req.query.excludeId, 'Empleado no válido') }
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
    if (q) where.OR = ['first_name', 'last_name', 'code', 'position'].map(key => ({ [key]: { contains: q, mode: 'insensitive' } }))
    const totalItems = await prisma.employee.count({ where }), totalPages = Math.max(1, Math.ceil(totalItems / pageSize)), page = Math.min(totalPages, integer(req.query.page, 1))
    const items = await prisma.employee.findMany({ where, select: { id: true, code: true, first_name: true, last_name: true, position: true, branch: { select: { id: true, name: true } } }, orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }, { id: 'asc' }], take: pageSize, skip: (page - 1) * pageSize })
    res.json({ items, page, pageSize, totalPages, totalItems })
  } catch (error) { next(error) }
}
