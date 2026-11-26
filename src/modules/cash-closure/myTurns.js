const { Prisma } = require('@prisma/client')
const shared = require('../../services/cashSharedSessions')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
async function myTurns(db, scope, sessionId) {
  if (![scope?.companyId,scope?.branchId,scope?.userId].every(v=>typeof v==='string'&&uuid.test(v))) fail(403,'Selecciona una empresa y sucursal')
  if (sessionId !== undefined && !uuid.test(String(sessionId))) fail(400,'Turno no válido')
  if (!await require('./eventStorage').ledgerAvailable(db)) return { available:false,current:[],pending:[] }
  const enabled = await shared.available(db), custody = await require('./custody').custodyAvailable(db)
  const rows = await db.$queryRaw(Prisma.sql`SELECT s.id,s.cash_register_id,s.status,s.operation_mode,s.register_type,s.money_event_version,s.opened_by_id,s.opened_at,s.closed_at,s.business_timezone,s.business_date::text AS business_date,
    r.name AS register_name,r.code AS register_code,u.name AS responsible_name,c.id AS closure_id,c.status AS closure_status,
    (SELECT count(*)::int FROM cash_money_events e WHERE e.cash_register_session_id=s.id AND e.actor_id=${scope.userId}::uuid) AS operation_count,
    ${custody ? Prisma.sql`EXISTS(SELECT 1 FROM cash_turn_handovers h WHERE h.cash_register_session_id=s.id)` : Prisma.sql`false`} AS handed_over
    FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id
    JOIN users u ON u.id=s.opened_by_id LEFT JOIN cash_closures c ON c.id=s.cash_closure_id
    WHERE b.company_id=${scope.companyId}::uuid AND r.branch_id=${scope.branchId}::uuid
    ${sessionId ? Prisma.sql`AND s.id=${sessionId}::uuid` : Prisma.empty}
    AND (s.opened_by_id=${scope.userId}::uuid ${sessionId && scope.canManageTeam ? Prisma.sql`OR s.operation_mode='SHARED'` : Prisma.empty} ${enabled ? Prisma.sql`OR EXISTS(SELECT 1 FROM cash_session_participants p WHERE p.session_id=s.id AND p.user_id=${scope.userId}::uuid)
      OR s.status='OPEN' AND s.operation_mode='SHARED' AND EXISTS(SELECT 1 FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE'
      JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id WHERE a.register_id=r.id AND a.user_id=${scope.userId}::uuid AND a.active)` : Prisma.empty})
    ORDER BY s.opened_at DESC,s.id`)
  if (sessionId && !rows.length) fail(404,'Turno no encontrado en la sucursal activa')
  const items = []
  for (const r of rows) {
    const owner = r.opened_by_id === scope.userId, data = await shared.view(db,scope,r)
    const responsible = owner || scope.canManageTeam === true
    const state = r.status === 'OPEN' ? 'OPERATING' : !r.closure_id ? 'PENDING_COUNT' : ({ Reconteo:'RECOUNT',Rechazado:'REJECTED',Aprobado:'FINALIZED',Cerrado:'FINALIZED' }[r.closure_status] || 'PENDING_REVIEW')
    items.push({ id:r.id,registerId:r.cash_register_id,registerName:r.register_name,registerCode:r.register_code,operationMode:r.operation_mode || 'INDIVIDUAL',registerType:r.register_type || 'PHYSICAL',
      responsibleName:r.responsible_name,role:owner?'RESPONSIBLE':data.actor_participant?'PARTICIPANT':'INVITED',participants:data.participants || [],
      openedAt:r.opened_at,closedAt:r.closed_at,timeZone:r.business_timezone || 'America/Guatemala',businessDate:r.business_date,state,closureId:r.closure_id,closureStatus:r.closure_status,operationCount:r.operation_count,
      pending:r.status!=='OPEN' && (['PENDING_COUNT','RECOUNT','REJECTED'].includes(state) || custody && r.money_event_version===1 && r.register_type==='PHYSICAL' && !r.handed_over),
      can:{ join:!!(scope.canJoin || scope.canOperate) && data.can_join===true,close:!!scope.canOperate && r.status==='OPEN' && responsible,
        count:!!scope.canDeclare && responsible && ['PENDING_COUNT','RECOUNT'].includes(state),
        handover:r.status==='CLOSED' && r.money_event_version===1 && r.register_type==='PHYSICAL' && !r.handed_over && (owner && !!scope.canHandoverOwn || !!scope.canHandoverTeam),
        movement:r.status==='OPEN' && (r.operation_mode==='SHARED'?data.can_operate===true:owner) && !!scope.canCreateMovement },needsCloseReason:!owner })
  }
  return { available:true,current:items.filter(r=>r.state==='OPERATING'),pending:items.filter(r=>r.pending) }
}
module.exports = { myTurns }
