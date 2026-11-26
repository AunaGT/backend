const { createHash, randomUUID } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { exactMoney } = require('../receivables/paymentAttempts')
const { lockScopedSession, assertSessionOperation } = require('../../services/cashSessionBoundary')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
function id(value) { if (typeof value !== 'string' || !uuid.test(value)) fail(400,'CASH_MOVEMENT_ID','Identificador no válido'); return value.toLowerCase() }
function text(value, max, required = true) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || value.trim().length > max || required && !value.trim()) fail(400,'CASH_MOVEMENT_TEXT','Completa el motivo y la procedencia o destino dentro del límite indicado')
  return value.trim() || null
}
function parsePhysicalMovement(raw, { originalId = null } = {}) {
  const keys = ['requestKey','cashRegisterSessionId','reason','reference', ...(originalId ? [] : ['direction','amount','paymentMethodId','counterpartyLabel'])]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k))) fail(400,'CASH_MOVEMENT_INVALID','Datos de movimiento no válidos')
  const input = { requestKey: id(raw.requestKey), cashRegisterSessionId: id(raw.cashRegisterSessionId), reason: text(raw.reason,500), reference: text(raw.reference,255,false) }
  if (originalId) return { ...input, originalId: id(originalId) }
  if (!['IN','OUT'].includes(raw.direction) || typeof raw.amount !== 'string') fail(400,'CASH_MOVEMENT_AMOUNT','Indica un importe positivo con hasta dos decimales')
  const amount = exactMoney(raw.amount)
  if (!Number.isSafeInteger(raw.paymentMethodId) || raw.paymentMethodId < 1 || raw.paymentMethodId > 2147483647) fail(400,'CASH_MOVEMENT_METHOD','Selecciona el medio efectivo')
  return { ...input, direction: raw.direction, amount, paymentMethodId: raw.paymentMethodId, counterpartyLabel: text(raw.counterpartyLabel,120) }
}
function physicalMovementHash(input) {
  const { requestKey, ...intent } = input
  return createHash('sha256').update(JSON.stringify(Object.keys(intent).sort().map(k => [k,intent[k]]))).digest('hex')
}
function requireScope(scope) {
  if (![scope?.companyId,scope?.branchId,scope?.userId].every(v => typeof v === 'string' && uuid.test(v))) fail(403,'CASH_SCOPE_REQUIRED','Selecciona una empresa y sucursal')
}
async function physicalMovementsAvailable(db) {
  const [row] = await db.$queryRaw`SELECT to_regclass('cash_physical_movements') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('cash_money_events') AND attname='physical_movement_id' AND NOT attisdropped) AS available`
  return row?.available === true
}
async function requireAvailable(db) { if (!await physicalMovementsAvailable(db)) fail(409,'CASH_MOVEMENTS_UNAVAILABLE','Los movimientos físicos todavía no están disponibles. No se registró dinero.') }
function dto(row) {
  return { ...row, amount: new Prisma.Decimal(String(row.amount)).toFixed(2), economic_at: new Date(row.economic_at).toISOString(), created_at: new Date(row.created_at).toISOString() }
}
const select = Prisma.sql`SELECT m.*,u.name AS actor_name,r.name AS register_name,s.opened_by_id,owner.name AS responsible_name,
  s.business_timezone,correction.id AS correction_id FROM cash_physical_movements m JOIN users u ON u.id=m.actor_id
  JOIN cash_registers r ON r.id=m.cash_register_id JOIN cash_register_sessions s ON s.id=m.cash_register_session_id
  JOIN users owner ON owner.id=s.opened_by_id LEFT JOIN cash_physical_movements correction ON correction.corrects_movement_id=m.id`
async function readRow(db, scope, movementId) {
  const [row] = await db.$queryRaw(Prisma.sql`${select} WHERE m.id=${movementId}::uuid AND m.company_id=${scope.companyId}::uuid AND m.branch_id=${scope.branchId}::uuid`)
  return row
}
function assertRead(scope, row) {
  if (!row || !scope.isAdmin && !scope.canViewTeam && (!scope.canViewOwn || row.actor_id !== scope.userId)) fail(404,'CASH_MOVEMENT_NOT_FOUND','Movimiento no disponible en la sucursal seleccionada')
}
async function getPhysicalMovement(db, scope, movementId) {
  requireScope(scope); id(movementId); await requireAvailable(db)
  const row = await readRow(db,scope,movementId); assertRead(scope,row); return dto(row)
}
async function listPhysicalMovements(db, scope, { view = 'own', sessionId, page = 1, pageSize = 20, direction, search = '' } = {}) {
  requireScope(scope); await requireAvailable(db)
  if (!['own','team'].includes(view) || !Number.isSafeInteger(Number(page)) || Number(page)<1 || !Number.isSafeInteger(Number(pageSize)) || Number(pageSize)<1 || Number(pageSize)>50 || typeof search !== 'string' || search.length>100 || direction && !['IN','OUT'].includes(direction)) fail(400,'CASH_MOVEMENT_FILTER','Revisa los filtros de movimientos')
  if (view === 'team' ? !scope.canViewTeam && !scope.isAdmin : !scope.canViewOwn && !scope.canViewTeam && !scope.isAdmin) fail(403,'CASH_MOVEMENT_FORBIDDEN','No tienes permiso para esa consulta')
  const where = Prisma.sql`m.company_id=${scope.companyId}::uuid AND m.branch_id=${scope.branchId}::uuid
    ${view === 'own' ? Prisma.sql`AND m.actor_id=${scope.userId}::uuid` : Prisma.empty}
    ${sessionId ? Prisma.sql`AND m.cash_register_session_id=${id(sessionId)}::uuid` : Prisma.empty}
    ${direction ? Prisma.sql`AND m.direction=${direction}` : Prisma.empty}
    ${search.trim() ? Prisma.sql`AND (m.reason ILIKE ${'%'+search.trim()+'%'} OR m.counterparty_label ILIKE ${'%'+search.trim()+'%'} OR r.name ILIKE ${'%'+search.trim()+'%'})` : Prisma.empty}`
  const items = await db.$queryRaw(Prisma.sql`${select} WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page)-1)*Number(pageSize)}`)
  // Totales del filtro completo (no solo de la página visible), como texto exacto.
  const [count] = await db.$queryRaw(Prisma.sql`SELECT count(*)::int AS n,round(coalesce(sum(m.amount) FILTER (WHERE m.direction='IN'),0),2)::text AS in_amount,
    round(coalesce(sum(m.amount) FILTER (WHERE m.direction='OUT'),0),2)::text AS out_amount FROM cash_physical_movements m JOIN cash_registers r ON r.id=m.cash_register_id WHERE ${where}`)
  return { items: items.map(dto), totalItems: count.n, page: Number(page), pageSize: Number(pageSize), totalPages: Math.max(1,Math.ceil(count.n/Number(pageSize))), summary: { inAmount: count.in_amount, outAmount: count.out_amount } }
}
async function attempt(tx, scope, input) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-physical',scope.companyId,scope.branchId,scope.userId,input.requestKey])},0))::text`
  const [old] = await tx.$queryRaw`SELECT id,request_hash FROM cash_physical_movements WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND actor_id=${scope.userId}::uuid AND request_key=${input.requestKey}::uuid`
  const hash = physicalMovementHash(input)
  if (old && old.request_hash !== hash) fail(409,'CASH_MOVEMENT_ATTEMPT_CONFLICT','Este intento corresponde a otro movimiento; recupera su resultado antes de cambiarlo')
  return { old, hash }
}
async function receipt(tx, scope, movementId, replayed) {
  const row = await readRow(tx,scope,movementId)
  return { id: row.id, requestKey: row.request_key, requestHash: row.request_hash, replayed, movement: dto(row) }
}
async function save(tx, scope, raw, originalId) {
  requireScope(scope)
  if (originalId ? !scope.canCorrect && !scope.isAdmin : !scope.canCreateOwn && !scope.canCreateTeam && !scope.isAdmin) fail(403,'CASH_MOVEMENT_FORBIDDEN','No tienes permiso para registrar este movimiento')
  const input = parsePhysicalMovement(raw,{ originalId }); await requireAvailable(tx)
  const { old, hash } = await attempt(tx,scope,input)
  if (old) return receipt(tx,scope,old.id,true)
  const session = await lockScopedSession(tx,scope,input.cashRegisterSessionId)
  assertSessionOperation(session,scope,{ settlementKind:'CASH',allowOtherUser:scope.canCreateTeam===true })
  if (session.money_event_version!==1 || session.register_type!=='PHYSICAL') fail(409,'CASH_PHYSICAL_TURN','Selecciona un turno físico con libro de movimientos habilitado')
  if (!scope.isAdmin) {
    const members = await tx.$queryRaw`SELECT uc.user_id FROM user_companies uc JOIN user_branches ub ON ub.user_id=uc.user_id
      WHERE uc.company_id=${scope.companyId}::uuid AND uc.user_id=${scope.userId}::uuid AND uc.status='ACTIVE' AND ub.branch_id=${scope.branchId}::uuid FOR SHARE OF uc,ub`
    if (!members.length) fail(403,'CASH_MOVEMENT_MEMBERSHIP','Ya no tienes acceso activo a esta sucursal')
  }
  let original
  if (originalId) {
    original = await readRow(tx,scope,input.originalId)
    if (!original || original.actor_id!==scope.userId && !scope.canCreateTeam && !scope.isAdmin) fail(404,'CASH_MOVEMENT_NOT_FOUND','Movimiento no disponible en la sucursal seleccionada')
    if (original.corrects_movement_id || original.correction_id || original.currency_code!==session.currency_code) fail(409,'CASH_PHYSICAL_CORRECTION','El movimiento ya fue compensado, es una compensación o tiene otra moneda')
  }
  const amount = original ? new Prisma.Decimal(String(original.amount)).toFixed(2) : input.amount
  const direction = original ? original.direction==='IN'?'OUT':'IN' : input.direction
  const methodId = original?.payment_method_id || input.paymentMethodId
  const method = await require('../../services/paymentMethods/access').resolvePaymentMethod(tx,{companyId:scope.companyId,methodId,purpose:direction==='IN'?'RECEIPT':'REFUND'})
  if (method.settlement_kind!=='CASH' || method.is_credit) fail(409,'CASH_PHYSICAL_METHOD','Este movimiento requiere un medio activo de efectivo, no tarjeta, transferencia ni crédito')
  if (direction==='OUT') {
    const [balance] = await tx.$queryRaw`SELECT coalesce(sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END),0)::text AS amount FROM cash_money_events WHERE cash_register_session_id=${session.id}::uuid AND settlement_kind='CASH'`
    if (new Prisma.Decimal(String(session.opening_float)).add(balance.amount).lt(amount)) fail(409,'CASH_PHYSICAL_INSUFFICIENT','El retiro supera el efectivo esperado disponible; revisa el conteo sin registrar ingresos ficticios')
  }
  const movementId=randomUUID()
  try {
    await tx.$executeRaw`INSERT INTO cash_physical_movements(id,company_id,branch_id,cash_register_id,cash_register_session_id,actor_id,request_key,request_hash,direction,amount,payment_method_id,payment_method_name,currency_code,reason,counterparty_label,reference,corrects_movement_id)
      VALUES(${movementId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${session.cash_register_id}::uuid,${session.id}::uuid,${scope.userId}::uuid,${input.requestKey}::uuid,${hash},${direction},${amount}::numeric,${method.id},${method.name},${session.currency_code},${input.reason},${original?'Compensación de movimiento':input.counterpartyLabel},${input.reference},${original?.id||null}::uuid)`
  } catch(error) {
    if (error.code==='P2010' && ['23505','23514'].includes(error.meta?.code)) fail(409,'CASH_PHYSICAL_CONFLICT','El movimiento cambió o ya fue compensado; consulta su estado actual')
    throw error
  }
  await require('./events').recordMoneyEvent(tx,scope,{session,sourceType:'PHYSICAL_MOVEMENT',sourceId:movementId})
  return receipt(tx,scope,movementId,false)
}
const createPhysicalMovement = (tx,scope,input) => save(tx,scope,input,null)
const correctPhysicalMovement = (tx,scope,originalId,input) => save(tx,scope,input,id(originalId))
async function physicalMovementOptions(db,scope) {
  requireScope(scope)
  if(!await physicalMovementsAvailable(db))return {available:false,sessions:[],methods:[]}
  const shared = await require('../../services/cashSharedSessions').available(db)
  const sessions=await db.$queryRaw(Prisma.sql`SELECT s.id,r.name AS register_name,r.code AS register_code,s.opened_by_id,u.name AS responsible_name,s.currency_code,s.opened_at,s.business_timezone
    FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id JOIN users u ON u.id=s.opened_by_id
    WHERE b.company_id=${scope.companyId}::uuid AND r.branch_id=${scope.branchId}::uuid AND r.active AND s.status='OPEN' AND s.money_event_version=1
      AND s.register_type='PHYSICAL' ${scope.canCreateTeam||scope.isAdmin?Prisma.empty:Prisma.sql`AND (s.opened_by_id=${scope.userId}::uuid ${shared ? Prisma.sql`OR s.operation_mode='SHARED' AND EXISTS(SELECT 1 FROM cash_session_participants p JOIN cash_register_access a ON a.register_id=r.id AND a.user_id=p.user_id AND a.active WHERE p.session_id=s.id AND p.user_id=${scope.userId}::uuid)` : Prisma.empty})`} ORDER BY r.name,s.id`)
  const choices=await require('../../services/paymentMethods/access').listPaymentMethodChoices(db,scope.companyId)
  return {available:true,sessions,methods:choices.filter(m=>m.settlement_kind==='CASH'&&!m.is_credit).map(m=>({id:m.id,name:m.name}))}
}
module.exports = { parsePhysicalMovement, physicalMovementHash, physicalMovementsAvailable, createPhysicalMovement, correctPhysicalMovement, listPhysicalMovements, getPhysicalMovement, physicalMovementOptions }
