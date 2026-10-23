const { DateTime } = require('luxon')
const { fail, toUuid } = require('../../modules/hr/domain/validation')

const today = (now = new Date()) => DateTime.fromJSDate(now, { zone: 'America/Guatemala' }).toISODate()
function reasonOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000) fail(400, 'Indica un motivo de 1 a 1000 caracteres')
  return value.trim()
}
function parseDeductionInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'Revisa los datos del descuento')
  const employeeId = toUuid(raw.employee_id, 'Empleado no encontrado')
  if (typeof raw.amount !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(raw.amount) || Number(raw.amount) <= 0) fail(400, 'El monto debe ser positivo, con hasta dos decimales y no mayor de 9 999 999 999,99')
  const [whole, fraction = ''] = raw.amount.split('.')
  return { employeeId, amount: `${BigInt(whole)}.${fraction.padEnd(2, '0')}`, reason: reasonOf(raw.reason), targetRunId: raw.target_run_id == null ? null : toUuid(raw.target_run_id, 'Nómina no encontrada') }
}
function assertPendingRevision(row, revision) {
  if (row.status !== 'PENDIENTE') fail(409, 'Solo se pueden modificar descuentos pendientes')
  if (!Number.isSafeInteger(revision) || revision !== row.revision) fail(409, 'El descuento cambió. Recarga sus datos antes de guardar')
}
async function lockDeductionEmployees(tx, { companyId, branchId }, employeeIds) {
  for (const id of [...new Set(employeeIds)].sort()) {
    const rows = await tx.$queryRaw`SELECT id FROM employees WHERE id=${id}::uuid AND company_id=${companyId}::uuid AND branch_id=${branchId}::uuid FOR UPDATE`
    if (!rows.length) fail(409, 'El empleado cambió de sucursal o ya no está disponible. Revisa los datos antes de continuar')
  }
}
async function validateDeductionTarget(tx, scope, employeeId, targetRunId, now = new Date()) {
  if (!targetRunId) return null
  const run = await tx.payrollRun.findFirst({ where: { id: targetRunId, company_id: scope.companyId, branch_id: scope.branchId }, include: { payslips: { select: { employee_id: true } } } })
  if (!run) fail(404, 'Nómina no encontrada')
  if (run.status !== 'BORRADOR' || run.type !== 'ORDINARIA' || run.pay_date.toISOString().slice(0, 10) < today(now) || !run.payslips.some(p => p.employee_id === employeeId)) fail(422, 'Selecciona una nómina ordinaria en borrador, con pago pendiente y que incluya al empleado')
  return run
}
const snapshot = row => ({ id: row.id, revision: row.revision, amount: String(row.amount), reason: row.reason, target_run_id: row.target_run_id, employee_id: row.employee_id })
async function auditDeduction(tx, scope, event, before, after) {
  const row = after || before
  await tx.employeeHistory.create({ data: { company_id: scope.companyId, employee_id: row.employee_id, actor_id: scope.userId || null, event, changes: { deductionId: row.id, before: before ? { ...snapshot(before), status: before.status, applied_run_id: before.applied_run_id, cancelled_reason: before.cancelled_reason } : null, after: after ? { ...snapshot(after), status: after.status, applied_run_id: after.applied_run_id, cancelled_reason: after.cancelled_reason } : null } } })
}
async function eligibleDeductions(tx, { companyId, branchId, run, employeeIds }) {
  if (run.type !== 'ORDINARIA' || !employeeIds.length) return []
  const lastDay = run.pay_date.toISOString().slice(0, 10)
  const cutoff = DateTime.fromISO(lastDay, { zone: 'America/Guatemala' }).plus({ days: 1 }).startOf('day').toJSDate()
  return tx.employeeDeduction.findMany({ where: { company_id: companyId, branch_id: branchId, employee_id: { in: employeeIds }, employee: { company_id: companyId, branch_id: branchId }, status: 'PENDIENTE', created_at: { lt: cutoff }, OR: [{ target_run_id: null }, { target_run_id: run.id }] }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] })
}
async function claimDeductions(tx, { run, userId }) {
  if (run.type !== 'ORDINARIA') return
  const scope = { companyId: run.company_id, branchId: run.branch_id, userId }
  const ids = run.payslips.map(p => p.employee_id)
  await lockDeductionEmployees(tx, scope, ids)
  const rows = await eligibleDeductions(tx, { ...scope, run, employeeIds: ids })
  const lines = run.payslips.flatMap(p => p.lines.filter(l => l.concept === 'OTRA_DEDUCCION').map(l => ({ ...l, employee_id: p.employee_id })))
  const stale = () => fail(409, 'Los descuentos cambiaron desde que se preparó la nómina. Recalcula antes de confirmar')
  if (lines.length !== rows.length) stale()
  const byId = new Map(lines.map(l => [l.deduction_id, l]))
  if (byId.size !== lines.length) stale()
  for (const row of rows) {
    const line = byId.get(row.id), frozen = line?.deduction_snapshot
    if (!line || line.employee_id !== row.employee_id || !frozen || frozen.revision !== row.revision || frozen.reason !== row.reason || frozen.target_run_id !== row.target_run_id || Number(line.amount) !== Number(row.amount) || Number(frozen.amount) !== Number(row.amount)) stale()
  }
  for (const row of rows) {
    const data = { status: 'APLICADO', applied_run_id: run.id, applied_at: new Date(), updated_by: userId || null, revision: { increment: 1 } }
    const result = await tx.employeeDeduction.updateMany({ where: { id: row.id, company_id: run.company_id, branch_id: run.branch_id, status: 'PENDIENTE', revision: row.revision }, data })
    if (result.count !== 1) stale()
    await auditDeduction(tx, scope, 'DEDUCTION_APPLIED', row, { ...row, ...data, revision: row.revision + 1 })
  }
}
async function restoreDeductions(tx, { run, userId }) {
  const scope = { companyId: run.company_id, branchId: run.branch_id, userId }
  const rows = await tx.employeeDeduction.findMany({ where: { company_id: run.company_id, branch_id: run.branch_id, status: 'APLICADO', applied_run_id: run.id } })
  // The employee may have moved since confirmation; lock by original company, not current branch.
  for (const id of [...new Set(rows.map(r => r.employee_id))].sort()) await tx.$queryRaw`SELECT id FROM employees WHERE id=${id}::uuid AND company_id=${run.company_id}::uuid FOR UPDATE`
  for (const row of rows) {
    const data = { status: 'PENDIENTE', applied_run_id: null, applied_at: null, updated_by: userId || null, revision: { increment: 1 } }
    const claim = await tx.employeeDeduction.updateMany({ where: { id: row.id, status: 'APLICADO', applied_run_id: run.id, revision: row.revision }, data })
    if (claim.count !== 1) fail(409, 'El descuento cambió antes de restituirse')
    await auditDeduction(tx, scope, 'DEDUCTION_RESTORED', row, { ...row, ...data, revision: row.revision + 1 })
  }
}
module.exports = { today, reasonOf, parseDeductionInput, assertPendingRevision, lockDeductionEmployees, validateDeductionTarget, snapshot, auditDeduction, eligibleDeductions, claimDeductions, restoreDeductions }
