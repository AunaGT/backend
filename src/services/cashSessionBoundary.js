function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
function requireScope(scope, id) {
  if (!scope?.companyId || !scope.branchId) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  if (typeof id !== 'string' || !uuid.test(id)) fail(400, 'CASH_ID_INVALID', 'Selecciona una caja o turno válido')
}

// The caller owns the transaction; acquire this before customer/document/stock locks.
async function lockScopedSession(tx, scope, sessionId) {
  requireScope(scope, sessionId)
  const rows = await tx.$queryRaw`SELECT s.*, r.active AS register_active, r.kind AS register_kind,
    r.branch_id, b.company_id, to_jsonb(r)->>'access_control_version' AS register_access_version FROM cash_register_sessions s
    JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id
    WHERE s.id=${sessionId}::uuid AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid
    FOR UPDATE OF s`
  if (!rows.length) fail(404, 'CASH_SESSION_NOT_FOUND', 'Turno no encontrado en la sucursal activa')
  if (rows[0].status === 'OPEN' && Number(rows[0].register_access_version) === 1) rows[0].register_access_allowed = await require('../modules/sales/cashRegisters.access').hasExplicitRegisterAccess(tx, scope, rows[0].cash_register_id, rows[0].register_access_version, rows[0].opened_by_id)
  if (require('./cashSharedSessions').isShared(rows[0])) {
    rows[0].actor_access_allowed = await require('../modules/sales/cashRegisters.access').hasExplicitRegisterAccess(tx, scope, rows[0].cash_register_id, 1, scope.userId)
    rows[0].actor_participant = await require('./cashSharedSessions').participated(tx, rows[0].id, scope.userId)
  }
  return rows[0]
}
async function lockScopedRegister(tx, scope, registerId) {
  requireScope(scope, registerId)
  const rows = await tx.$queryRaw`SELECT r.* FROM cash_registers r JOIN branches b ON b.id=r.branch_id
    WHERE r.id=${registerId}::uuid AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND r.active=true
    FOR UPDATE OF r`
  if (!rows.length) fail(404, 'CASH_REGISTER_NOT_FOUND', 'Caja activa no encontrada en esta sucursal')
  await require('../modules/sales/cashRegisters.access').assertExplicitRegisterAccess(tx, scope, registerId, rows[0].access_control_version, scope.userId)
  return rows[0]
}
function assertSessionOperation(session, scope, { settlementKind, paidAt, allowOtherUser = false } = {}) {
  if (!scope?.userId) fail(401, 'CASH_ACTOR_REQUIRED', 'Usuario no autenticado')
  if (session.status !== 'OPEN') fail(409, 'CASH_SESSION_CLOSED', 'El turno ya terminó. Selecciona un turno abierto antes de registrar el dinero.')
  if (!session.register_active) fail(409, 'CASH_REGISTER_INACTIVE', 'Esta caja está inactiva. Selecciona otra caja abierta.')
  if (require('./cashSharedSessions').isShared(session)) {
    if (!session.actor_access_allowed || !session.actor_participant) fail(403, 'CASH_SHARED_PARTICIPANT_REQUIRED', 'Debes estar autorizado y unirte al turno compartido antes de registrar dinero.')
  } else {
    if (Number(session.register_access_version) === 1 && session.register_access_allowed !== true) fail(403, 'CASH_REGISTER_ACCESS_DENIED', 'El responsable ya no tiene acceso activo a esta caja. Un encargado puede terminar el turno, pero no registrar dinero nuevo.')
    if (scope.isAdmin !== true && session.opened_by_id !== scope.userId && allowOtherUser !== true) fail(403, 'CASH_SESSION_OTHER_USER', 'Solo puedes registrar dinero en tu propio turno autorizado.')
  }
  if (session.register_kind === 'VIRTUAL' && settlementKind !== undefined && settlementKind !== 'BANK') fail(409, 'CASH_VIRTUAL_METHOD', 'Una caja virtual solo admite medios digitales, no efectivo ni crédito.')
  if (paidAt !== undefined && (!Number.isFinite(new Date(paidAt).getTime()) || new Date(paidAt) < new Date(session.opened_at))) fail(400, 'CASH_PAYMENT_DATE', 'La fecha del pago no puede ser anterior a la apertura del turno.')
}
module.exports = { lockScopedSession, lockScopedRegister, assertSessionOperation }
