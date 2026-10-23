const { prisma, prismaTransaction } = require('../../../models/prisma')
const { requireCompany, requireBranch, branchWhere, hasPerm } = require('../../../middlewares/tenant')
const { fail, toUuid, toEnum } = require('../domain/validation')
const { today, reasonOf, parseDeductionInput, assertPendingRevision, lockDeductionEmployees, validateDeductionTarget, auditDeduction } = require('../../../services/payroll/deductions')
const { lockPayrollRun } = require('../../../services/payroll/rateVersions')
const TX = { maxWait: 10000, timeout: 30000 }
const INCLUDE = {
  employee: { select: { id: true, code: true, first_name: true, last_name: true } },
  target_run: { select: { id: true, code: true, name: true, pay_date: true, status: true } },
  applied_run: { select: { id: true, code: true, name: true, pay_date: true, status: true } },
  createdBy: { select: { id: true, name: true } },
}
function access(req, write = false) {
  if (!hasPerm(req.user, write ? 'hr.deductions.manage' : 'hr.deductions.view')) fail(403, 'No tienes permiso para esta operación con descuentos')
  return { companyId: requireCompany(req), branchId: write ? requireBranch(req) : req.branchId, userId: req.user?.sub }
}
const positive = (v, fallback) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback
async function paginate(model, where, req, args = {}) {
  const pageSize = Math.min(100, positive(req.query.pageSize, 50)), totalItems = await model.count({ where }), totalPages = Math.max(1, Math.ceil(totalItems / pageSize)), page = Math.min(totalPages, positive(req.query.page, 1))
  const items = await model.findMany({ where, ...args, take: pageSize, skip: (page - 1) * pageSize })
  return { items, page, pageSize, totalItems, totalPages }
}
exports.list = async (req, res, next) => { try {
  const scope = access(req), where = { company_id: scope.companyId, ...branchWhere(req), employee: { company_id: scope.companyId, ...branchWhere(req) } }
  if (req.query.employee_id) where.employee_id = toUuid(req.query.employee_id, 'Empleado no encontrado')
  if (req.query.status) where.status = toEnum(req.query.status, ['PENDIENTE', 'APLICADO', 'CANCELADO'], 'Estado no válido')
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
  if (q) where.OR = [{ reason: { contains: q, mode: 'insensitive' } }, ...['first_name', 'last_name', 'code'].map(key => ({ employee: { [key]: { contains: q, mode: 'insensitive' } } }))]
  res.set('Cache-Control', 'private, no-store')
  res.json(await paginate(prisma.employeeDeduction, where, req, { include: INCLUDE, orderBy: [{ created_at: 'desc' }, { id: 'desc' }] }))
} catch (e) { next(e) } }
exports.targets = async (req, res, next) => { try {
  const scope = access(req), employeeId = toUuid(req.query.employee_id, 'Empleado no encontrado')
  const employee = await prisma.employee.findFirst({ where: { id: employeeId, company_id: scope.companyId, ...branchWhere(req) }, select: { branch_id: true } })
  if (!employee) fail(404, 'Empleado no encontrado')
  const where = { company_id: scope.companyId, branch_id: employee.branch_id, type: 'ORDINARIA', status: 'BORRADOR', pay_date: { gte: new Date(`${today()}T00:00:00Z`) }, payslips: { some: { employee_id: employeeId } } }
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
  if (q) where.OR = ['code', 'name'].map(key => ({ [key]: { contains: q, mode: 'insensitive' } }))
  res.set('Cache-Control', 'private, no-store')
  res.json(await paginate(prisma.payrollRun, where, req, { select: { id: true, code: true, name: true, pay_date: true, status: true }, orderBy: [{ pay_date: 'asc' }, { id: 'asc' }] }))
} catch (e) { next(e) } }
async function mutate(req, mode) {
  const scope = access(req, true), id = mode === 'create' ? null : toUuid(req.params.id, 'Descuento no encontrado')
  const input = mode === 'cancel' ? null : parseDeductionInput(req.body)
  const cancelReason = mode === 'cancel' ? reasonOf(req.body?.reason) : null
  return prismaTransaction.$transaction(async tx => {
    // Payroll always locks a destination run before its employees; keep the same order here.
    if (input?.targetRunId) await lockPayrollRun(tx, { id: input.targetRunId, companyId: scope.companyId, branchId: scope.branchId })
    const where = { id, company_id: scope.companyId, branch_id: scope.branchId }
    const before = id ? await tx.employeeDeduction.findFirst({ where }) : null
    if (id && !before) fail(404, 'Descuento no encontrado')
    if (before && input && before.employee_id !== input.employeeId) fail(400, 'El empleado de un descuento no se puede cambiar')
    const employeeId = before?.employee_id || input.employeeId
    const employee = await tx.employee.findFirst({ where: { id: employeeId, company_id: scope.companyId, branch_id: scope.branchId }, select: { id: true } })
    if (!employee) fail(404, 'Empleado no encontrado en esta sucursal')
    await lockDeductionEmployees(tx, scope, [employeeId])
    // Access may have been revoked while payroll or employee locks were held elsewhere.
    if (!scope.userId) fail(401, 'La sesión ha caducado')
    const actor = await require('../../users/roles/service').freshActor(tx, req, ['hr.deductions.manage'])
    if ((actor.auth_version || 0) !== (req.user.auth_version || 0)) fail(401, 'La sesión ha caducado')
    const membership = await tx.userBranch.findUnique({ where: { user_id_branch_id: { user_id: scope.userId, branch_id: scope.branchId } }, include: { branch: { select: { company_id: true, active: true, company: { select: { active: true } } } } } })
    if (!membership || membership.branch.company_id !== scope.companyId || !membership.branch.active || !membership.branch.company.active) fail(403, 'Ya no tienes acceso activo a esta sucursal')
    const current = id ? await tx.employeeDeduction.findFirst({ where }) : null
    if (current) assertPendingRevision(current, req.body?.revision)
    if (input) await validateDeductionTarget(tx, scope, employeeId, input.targetRunId)
    let after
    if (!id) after = await tx.employeeDeduction.create({ data: { company_id: scope.companyId, branch_id: scope.branchId, employee_id: employeeId, amount: input.amount, reason: input.reason, target_run_id: input.targetRunId, created_by: scope.userId || null, updated_by: scope.userId || null }, include: INCLUDE })
    else {
      const data = { revision: { increment: 1 }, updated_by: scope.userId || null, ...(mode === 'cancel' ? { status: 'CANCELADO', cancelled_at: new Date(), cancelled_by: scope.userId || null, cancelled_reason: cancelReason } : { amount: input.amount, reason: input.reason, target_run_id: input.targetRunId }) }
      const claim = await tx.employeeDeduction.updateMany({ where: { ...where, status: 'PENDIENTE', revision: req.body.revision }, data })
      if (claim.count !== 1) fail(409, 'El descuento cambió. Recarga antes de continuar')
      after = await tx.employeeDeduction.findFirst({ where, include: INCLUDE })
    }
    await auditDeduction(tx, scope, mode === 'create' ? 'DEDUCTION_CREATED' : mode === 'cancel' ? 'DEDUCTION_CANCELLED' : 'DEDUCTION_UPDATED', current, after)
    return after
  }, TX)
}
exports.create = async (req, res, next) => { try { res.status(201).json(await mutate(req, 'create')) } catch (e) { next(e) } }
exports.update = async (req, res, next) => { try { res.json(await mutate(req, 'update')) } catch (e) { next(e) } }
exports.cancel = async (req, res, next) => { try { res.json(await mutate(req, 'cancel')) } catch (e) { next(e) } }
