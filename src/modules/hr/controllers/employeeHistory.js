const { DateTime } = require('luxon')
const { prisma } = require('../../../models/prisma')
const { requireCompany, branchWhere, hasPerm } = require('../../../middlewares/tenant')
const { fail, toUuid } = require('../domain/validation')
async function scope(req) {
  const company_id = requireCompany(req), employee_id = toUuid(req.params.id, 'Empleado no encontrado')
  const item = await prisma.employee.findFirst({ where: { id: employee_id, company_id, ...branchWhere(req) }, select: { id: true } })
  if (!item) fail(404, 'Empleado no encontrado')
  return { company_id, employee_id }
}
exports.list = async (req, res, next) => {
  try {
    const where = await scope(req)
    const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    const pageSize = Math.min(32, positive(req.query.pageSize, 10)), totalItems = await prisma.employeeHistory.count({ where }), totalPages = Math.max(1, Math.ceil(totalItems / pageSize)), page = Math.min(totalPages, positive(req.query.page, 1))
    const items = await prisma.employeeHistory.findMany({ where, select: { id: true, event: true, changes: true, actor: { select: { id: true, name: true } }, created_at: true }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: pageSize, skip: (page - 1) * pageSize })
    res.set('Cache-Control', 'private, no-store'); res.json({ items, page, pageSize, totalItems, totalPages })
  } catch (error) { next(error) }
}
exports.overview = async (req, res, next) => {
  try {
    const where = await scope(req)
    const raw = req.query.month || DateTime.now().setZone('America/Guatemala').toFormat('yyyy-MM')
    if (!/^\d{4}-\d{2}$/.test(raw)) fail(400, 'El mes no es válido')
    const start = DateTime.fromISO(`${raw}-01`, { zone: 'UTC' })
    if (!start.isValid) fail(400, 'El mes no es válido')
    const result = { attendance: null, advances: null, documents: null, history: { count: 0 } }
    if (hasPerm(req.user, 'hr.attendance.view')) {
      const groups = await prisma.attendance.groupBy({ by: ['status'], where: { ...where, ...branchWhere(req), work_date: { gte: start.toJSDate(), lt: start.plus({ months: 1 }).toJSDate() } }, _count: { _all: true } })
      result.attendance = { marked: groups.reduce((sum, row) => sum + row._count._all, 0), present: groups.filter(row => ['PRESENTE', 'TARDE'].includes(row.status)).reduce((sum, row) => sum + row._count._all, 0) }
    }
    if (hasPerm(req.user, 'hr.advances.view')) {
      const aggregate = await prisma.employeeAdvance.aggregate({ where: { ...where, ...branchWhere(req), status: 'PENDIENTE' }, _count: { _all: true }, _sum: { balance: true } })
      result.advances = { count: aggregate._count._all, balance: String(aggregate._sum.balance || 0) }
    }
    if (hasPerm(req.user, 'hr.documents.view')) {
      const types = await prisma.employeeDocumentType.findMany({ where: { company_id: where.company_id, active: true, required: true }, select: { id: true, name: true } })
      const documents = await prisma.employeeDocument.findMany({ where: { ...where, archived_at: null }, select: { type_id: true } })
      const missingRequired = types.filter(type => !documents.some(document => document.type_id === type.id))
      result.documents = { complete: !missingRequired.length, missingRequired }
    }
    result.history.count = await prisma.employeeHistory.count({ where: { ...where, created_at: { gte: DateTime.now().minus({ months: 3 }).toJSDate() } } })
    res.set('Cache-Control', 'private, no-store'); res.json(result)
  } catch (error) { next(error) }
}
