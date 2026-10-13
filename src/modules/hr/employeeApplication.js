const { createHash, randomUUID } = require('node:crypto')
const { prisma, prismaTransaction } = require('../../models/prisma')
const storage = require('./documentStorage')
const { assertRequiredDocuments, validateDocumentFile } = require('./domain/documents')
const { fail, toUuid } = require('./domain/validation')
const EMPLOYEE_INCLUDE = { supervisor: { select: { id: true, first_name: true, last_name: true } }, branch: { select: { id: true, name: true, code: true } }, user: { select: { id: true, name: true, email: true } } }

function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}

async function employeeDto(employee) {
  const { creation_request_hash, creation_request_id, photo_storage_path, ...dto } = employee
  if (photo_storage_path) {
    const signed = await storage.signHrFile(photo_storage_path)
    dto.photo_url = signed.url
    dto.photo_expires_at = signed.expiresAt
  }
  return dto
}

async function createEmployeeWithDocuments(ctx, data, files = [], requestId = null) {
  if (requestId) requestId = toUuid(requestId, 'La clave de reintento no es válida')
  if (!Array.isArray(files) || files.length > 20) fail(400, 'Se permiten hasta 20 documentos por alta')
  if (files.length && !requestId) fail(400, 'La carga documental requiere una clave de reintento')
  const selected = files.map(selection => ({ ...selection, typeId: toUuid(selection.typeId, 'El tipo de documento no es válido'), metadata: validateDocumentFile(selection.file) }))
  // Hash only normalized employee data, identities of requirements and validated file content.
  const hash = createHash('sha256').update(JSON.stringify(canonical({ data, files: selected.map(s => ({ typeId: s.typeId, name: s.file.originalname, sha256: s.metadata.sha256 })).sort((a, b) => a.typeId.localeCompare(b.typeId)) }))).digest('hex')
  const lookup = () => requestId ? prisma.employee.findFirst({ where: { company_id: ctx.companyId, creation_request_id: requestId }, include: EMPLOYEE_INCLUDE }) : null
  const replay = async existing => {
    if (existing.branch_id !== ctx.branchId || existing.creation_request_hash !== hash) fail(409, 'La clave de reintento ya pertenece a otro envío; revisa los datos')
    return employeeDto(existing)
  }
  const existing = await lookup()
  if (existing) return replay(existing)
  const types = await prisma.employeeDocumentType.findMany({ where: { company_id: ctx.companyId, active: true } })
  assertRequiredDocuments(types, selected.map(s => s.typeId))
  if (selected.some(s => !types.some(t => t.id === s.typeId))) fail(400, 'Un tipo documental ya no está disponible en esta empresa')
  const employeeId = randomUUID(), uploaded = []
  try {
    for (const selection of selected) {
      const object = await storage.uploadHrFile({ companyId: ctx.companyId, employeeId, file: selection.file })
      uploaded.push({ ...selection, path: object.path })
    }
    let created
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        created = await (prismaTransaction || prisma).$transaction(async tx => {
          const currentTypes = await tx.employeeDocumentType.findMany({ where: { company_id: ctx.companyId, active: true } })
          try { assertRequiredDocuments(currentTypes, selected.map(s => s.typeId)) }
          catch (error) { if (error.status === 422) error.status = 409; throw error }
          if (selected.some(s => !currentTypes.some(t => t.id === s.typeId))) fail(409, 'La configuración documental cambió; revisa los requisitos')
          let code = data.code
          if (!code) {
            const last = await tx.employee.findFirst({ where: { company_id: ctx.companyId, code: { startsWith: 'EMP-' } }, orderBy: { code: 'desc' }, select: { code: true } })
            code = `EMP-${String((Number(last?.code?.slice(4)) || 0) + 1).padStart(4, '0')}`
          }
          const employee = await tx.employee.create({ data: { ...data, id: employeeId, company_id: ctx.companyId, branch_id: ctx.branchId, code, creation_request_id: requestId, creation_request_hash: requestId ? hash : null }, include: EMPLOYEE_INCLUDE })
          for (const selection of uploaded) await tx.employeeDocument.create({ data: {
            company_id: ctx.companyId, employee_id: employeeId, type_id: selection.typeId, storage_path: selection.path,
            original_name: selection.file.originalname, mime_type: selection.metadata.mimeType, size_bytes: selection.metadata.size, sha256: selection.metadata.sha256, uploaded_by: ctx.userId,
          } })
          await tx.employeeHistory.create({ data: { company_id: ctx.companyId, employee_id: employeeId, actor_id: ctx.userId, event: 'EMPLOYEE_CREATED', changes: { documentTypes: selected.map(s => s.typeId) } } })
          return employee
        }, { maxWait: 10000, timeout: 20000 })
        break
      } catch (error) {
        if (error.code !== 'P2002') throw error
        const winner = await lookup()
        if (winner) {
          await storage.removeNewHrFiles(uploaded.map(s => s.path)); uploaded.length = 0
          return replay(winner)
        }
        if (String(error.meta?.target).includes('user_id')) fail(409, 'Ese usuario ya está vinculado a otro empleado')
        if (data.code || attempt === 2) fail(409, 'El código de empleado ya existe; intenta de nuevo')
      }
    }
    // Persistence succeeded: do not clean files if DTO/signing fails afterwards.
    uploaded.length = 0
    return employeeDto(created)
  } catch (error) {
    if (uploaded.length) {
      try { await storage.removeNewHrFiles(uploaded.map(s => s.path)) }
      catch { error.message += '. No se pudo limpiar la carga incompleta; contacta al administrador'; error.cleanupFailed = true }
    }
    throw error
  }
}

module.exports = { createEmployeeWithDocuments, employeeDto, EMPLOYEE_INCLUDE }
