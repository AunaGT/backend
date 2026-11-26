const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const isShared = s => s?.money_event_version === 1 && s.operation_mode === 'SHARED'
const operationPermissions = ['receivables.manage','appointments.collect','returns.complete','merchandise.mark_paid','cash.movements.create_own','cash.movements.create_team','cash.transfers.operate_own','cash.transfers.operate_team']
async function available(db) {
  const [r] = await db.$queryRaw`SELECT to_regclass('cash_session_participants') IS NOT NULL AS available`
  return r?.available === true
}
async function participated(db, sessionId, userId) {
  if (!userId || !await available(db)) return false
  const [r] = await db.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_session_participants WHERE session_id=${sessionId}::uuid AND user_id=${userId}::uuid) AS joined`
  return r.joined
}
async function participants(db, sessionId) {
  if (!await available(db)) return []
  return db.$queryRaw`SELECT p.user_id,u.name,p.joined_at FROM cash_session_participants p JOIN users u ON u.id=p.user_id WHERE p.session_id=${sessionId}::uuid ORDER BY p.joined_at,p.user_id`
}
async function join(tx, scope, sessionId) {
  const s = await require('./cashSessionBoundary').lockScopedSession(tx, scope, sessionId)
  if (!isShared(s) || s.status !== 'OPEN' || !s.register_active) fail(409, 'CASH_JOIN_UNAVAILABLE', 'El turno compartido ya no está disponible. Actualiza la caja.')
  if (!s.actor_access_allowed) fail(403, 'CASH_REGISTER_ACCESS_DENIED', 'No tienes acceso activo a esta caja')
  await tx.$executeRaw`INSERT INTO cash_session_participants(session_id,user_id) VALUES(${s.id}::uuid,${scope.userId}::uuid) ON CONFLICT DO NOTHING`
  return { ...s, actor_participant: true, can_operate: true, participants: await participants(tx, s.id) }
}
async function view(db, scope, session) {
  if (!isShared(session)) return session
  if (!await available(db)) return { ...session, can_operate: false, can_join: false }
  const joined = await participated(db, session.id, scope.userId)
  const access = await require('../modules/sales/cashRegisters.access').hasExplicitRegisterAccess(db, scope, session.cash_register_id, 1, scope.userId)
  return { ...session, actor_participant: joined, can_operate: joined && access && session.status === 'OPEN', can_join: !joined && access && session.status === 'OPEN', participants: await participants(db, session.id) }
}
async function currentRegister(db, userId, branchId) {
  if (typeof db.$queryRaw !== 'function' || !await available(db)) return null
  const [row] = await db.$queryRaw`SELECT r.id,r.name,r.code,r.is_default,r.active,r.branch_id FROM cash_register_sessions s
    JOIN cash_registers r ON r.id=s.cash_register_id LEFT JOIN cash_session_participants p ON p.session_id=s.id AND p.user_id=${userId}::uuid
    WHERE r.branch_id=${branchId}::uuid AND r.active AND s.status='OPEN' AND
    (s.operation_mode IS DISTINCT FROM 'SHARED' AND s.opened_by_id=${userId}::uuid OR s.operation_mode='SHARED' AND s.money_event_version=1 AND p.user_id IS NOT NULL
     AND EXISTS(SELECT 1 FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE'
      JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id WHERE a.register_id=r.id AND a.branch_id=r.branch_id AND a.user_id=${userId}::uuid AND a.active))
    ORDER BY coalesce(p.joined_at,s.opened_at) DESC,s.id DESC LIMIT 1`
  return row || null
}
module.exports = { isShared, available, participated, participants, join, view, currentRegister, operationPermissions }
