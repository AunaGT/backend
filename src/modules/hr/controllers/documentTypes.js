const { prisma } = require('../../../models/prisma')
const { requireCompany, hasPerm } = require('../../../middlewares/tenant')
const { fail, toUuid } = require('../domain/validation')
const { normalizeDocumentType } = require('../domain/documents')
const SELECT = { id: true, name: true, instructions: true, required: true, active: true, sort_order: true }

exports.list = async (req, res, next) => {
  try {
    const company_id = requireCompany(req)
    const administrative = req.query.includeInactive === '1'
    const allowed = administrative ? ['settings.view', 'settings.manage'] : ['settings.view', 'settings.manage', 'hr.employees.create', 'hr.documents.view', 'hr.documents.manage']
    if (!allowed.some(code => hasPerm(req.user, code))) fail(403, 'Sin permiso para consultar los requisitos documentales')
    const items = await prisma.employeeDocumentType.findMany({ where: { company_id, ...(!administrative ? { active: true } : {}) }, select: SELECT, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] })
    res.json({ items })
  } catch (error) { next(error) }
}
exports.create = async (req, res, next) => {
  try {
    const company_id = requireCompany(req)
    if (!hasPerm(req.user, 'settings.manage')) fail(403, 'Sin permiso para configurar expedientes')
    const item = await prisma.employeeDocumentType.create({ data: { company_id, ...normalizeDocumentType(req.body) }, select: SELECT })
    res.status(201).json(item)
  } catch (error) { next(error) }
}
exports.update = async (req, res, next) => {
  try {
    const company_id = requireCompany(req)
    if (!hasPerm(req.user, 'settings.manage')) fail(403, 'Sin permiso para configurar expedientes')
    const id = toUuid(req.params.typeId, 'Tipo de documento no encontrado')
    const current = await prisma.employeeDocumentType.findFirst({ where: { id, company_id }, select: SELECT })
    if (!current) fail(404, 'Tipo de documento no encontrado')
    res.json(await prisma.employeeDocumentType.update({ where: { id: current.id }, data: normalizeDocumentType({ ...current, ...req.body }), select: SELECT }))
  } catch (error) { next(error) }
}
