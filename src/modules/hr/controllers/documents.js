const { prisma, prismaTransaction } = require('../../../models/prisma')
const { requireCompany, requireBranch, branchWhere } = require('../../../middlewares/tenant')
const { fail, toUuid } = require('../domain/validation')
const { validateDocumentFile } = require('../domain/documents')
const storage = require('../documentStorage')
const SELECT = { id: true, type_id: true, original_name: true, mime_type: true, size_bytes: true, created_at: true, archived_at: true, uploaded_by: true }
const TYPE_SELECT = { id: true, name: true, instructions: true, required: true, active: true, sort_order: true }

async function scope(req, db = prisma) {
  const company_id = requireCompany(req), employee_id = toUuid(req.params.id, 'Empleado no encontrado')
  const employee = await db.employee.findFirst({ where: { id: employee_id, company_id, ...branchWhere(req) }, select: { id: true } })
  if (!employee) fail(404, 'Empleado no encontrado')
  return { company_id, employee_id }
}
async function version(req, context, db = prisma, select = SELECT) {
  const item = await db.employeeDocument.findFirst({ where: { id: toUuid(req.params.documentId, 'Documento no encontrado'), ...context }, select })
  if (!item) fail(404, 'Documento no encontrado')
  return item
}
async function lockEmployee(tx, context, req) {
  const branchId = requireBranch(req)
  const rows = await tx.$queryRaw`SELECT id FROM employees WHERE id = ${context.employee_id}::uuid AND company_id = ${context.company_id}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`
  if (!rows.length) fail(404, 'Empleado no encontrado')
}
const audit = (tx, context, req, event, document) => tx.employeeHistory.create({ data: { ...context, actor_id: req.user.sub, event, changes: { documentId: document.id, typeId: document.type_id } } })
const privateResponse = res => res.set('Cache-Control', 'private, no-store')

exports.list = async (req, res, next) => {
  try {
    const context = await scope(req)
    const [items, requirements] = await Promise.all([
      prisma.employeeDocument.findMany({ where: context, select: SELECT, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] }),
      prisma.employeeDocumentType.findMany({ where: { company_id: context.company_id, active: true }, select: TYPE_SELECT, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }),
    ])
    const current = new Set(items.filter(i => !i.archived_at).map(i => i.type_id))
    privateResponse(res); res.json({ items, requirements, complete: requirements.every(t => !t.required || current.has(t.id)) })
  } catch (error) { next(error) }
}
exports.access = async (req, res, next) => {
  try {
    const context = await scope(req)
    if (req.body.download !== undefined && typeof req.body.download !== 'boolean') fail(400, 'El modo de descarga no es válido')
    const item = await version(req, context, prisma, { storage_path: true, original_name: true })
    const signed = await storage.signHrFile(item.storage_path, req.body.download ? { downloadName: item.original_name } : {})
    privateResponse(res); res.json(signed)
  } catch (error) { next(error) }
}
exports.upload = async (req, res, next) => {
  let newPath
  try {
    requireBranch(req)
    const context = await scope(req)
    const typeId = toUuid(req.body.type_id, 'El tipo de documento no es válido')
    const type = await prisma.employeeDocumentType.findFirst({ where: { id: typeId, company_id: context.company_id, active: true }, select: { id: true } })
    if (!type) fail(400, 'El tipo documental ya no está disponible')
    const metadata = validateDocumentFile(req.file)
    const object = await storage.uploadHrFile({ companyId: context.company_id, employeeId: context.employee_id, file: req.file })
    newPath = object.path
    const item = await (prismaTransaction || prisma).$transaction(async tx => {
      await lockEmployee(tx, context, req)
      const currentType = await tx.employeeDocumentType.findFirst({ where: { id: typeId, company_id: context.company_id, active: true }, select: { id: true } })
      if (!currentType) fail(409, 'La configuración documental cambió; selecciona un tipo vigente')
      const prior = await tx.employeeDocument.findFirst({ where: { ...context, type_id: typeId, archived_at: null }, select: { id: true } })
      if (prior) await tx.employeeDocument.update({ where: { id: prior.id }, data: { archived_at: new Date() } })
      const created = await tx.employeeDocument.create({ data: { ...context, type_id: typeId, storage_path: newPath, original_name: req.file.originalname, mime_type: metadata.mimeType, size_bytes: metadata.size, sha256: metadata.sha256, uploaded_by: req.user.sub }, select: SELECT })
      await audit(tx, context, req, prior ? 'DOCUMENT_REPLACED' : 'DOCUMENT_UPLOADED', created)
      return created
    }, { maxWait: 10000, timeout: 20000 })
    newPath = null
    privateResponse(res); res.status(201).json(item)
  } catch (error) {
    if (newPath) { try { await storage.removeNewHrFiles([newPath]) } catch { error.message += '. No se pudo limpiar la carga incompleta; contacta al administrador' } }
    if (error.code === 'P2002') { error.status = 409; error.message = 'El documento cambió durante la carga; revisa la versión vigente' }
    next(error)
  }
}
async function changeArchive(req, res, next, restore) {
  try {
    requireBranch(req)
    const context = await scope(req)
    const item = await (prismaTransaction || prisma).$transaction(async tx => {
      await lockEmployee(tx, context, req)
      const current = await version(req, context, tx)
      if (restore && current.archived_at) {
        const active = await tx.employeeDocument.findFirst({ where: { ...context, type_id: current.type_id, archived_at: null }, select: { id: true } })
        if (active) fail(409, 'Ya hay una versión vigente de este documento; archívala antes de restaurar')
      }
      if (restore ? !current.archived_at : current.archived_at) return current
      const updated = await tx.employeeDocument.update({ where: { id: current.id }, data: { archived_at: restore ? null : new Date() }, select: SELECT })
      await audit(tx, context, req, restore ? 'DOCUMENT_RESTORED' : 'DOCUMENT_ARCHIVED', current)
      return updated
    }, { maxWait: 10000, timeout: 20000 })
    privateResponse(res); res.json(item)
  } catch (error) { if (error.code === 'P2002') { error.status = 409; error.message = 'Otra versión está vigente; vuelve a consultar el expediente' } next(error) }
}
exports.archive = (req, res, next) => changeArchive(req, res, next, false)
exports.restore = (req, res, next) => changeArchive(req, res, next, true)
