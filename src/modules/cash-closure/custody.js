// Cajas 3B.2: custodias, traslados bilaterales, entrega de turno y fondo retenido.
// El llamador posee la transacción. Orden de bloqueos: titular de origen → titular de destino → traslado.
const { createHash, randomUUID } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { exactMoney } = require('../receivables/paymentAttempts')
const { lockScopedSession, assertSessionOperation } = require('../../services/cashSessionBoundary')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const D = value => new Prisma.Decimal(String(value ?? 0))
function id(value, label = 'Identificador') { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'CASH_CUSTODY_ID', `${label} no válido`); return value.toLowerCase() }
function text(value, max, required = true) {
  if (value == null && !required) return null
  if (typeof value !== 'string' || value.trim().length > max || required && !value.trim()) fail(400, 'CASH_CUSTODY_TEXT', 'Completa el motivo dentro del límite indicado')
  return value.trim() || null
}
function strict(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k))) fail(400, 'CASH_CUSTODY_INVALID', 'Datos del traslado no válidos')
  return raw
}
const money = (value, allowZero = false) => { if (typeof value !== 'string') fail(400, 'CASH_CUSTODY_AMOUNT', 'Indica el importe como texto con hasta dos decimales'); return exactMoney(value, { allowZero }) }
const hash = intent => createHash('sha256').update(JSON.stringify(Object.keys(intent).sort().map(k => [k, intent[k]]))).digest('hex')
function requireScope(scope) {
  if (![scope?.companyId, scope?.branchId, scope?.userId].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
}
async function custodyAvailable(db) {
  const [row] = await db.$queryRaw`SELECT to_regclass('cash_custody_entries') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('cash_money_events') AND attname='custody_entry_id' AND NOT attisdropped) AS available`
  return row?.available === true
}
async function requireAvailable(db) { if (!await custodyAvailable(db)) fail(409, 'CASH_CUSTODY_UNAVAILABLE', 'La custodia de efectivo todavía no está disponible. No se movió dinero.') }
// Las guardas de la base hablan en códigos; aquí se traducen sin ocultar que nada se registró.
const DB_ERRORS = {
  cash_custody_insufficient: 'El importe supera el efectivo disponible en el origen. No se movió dinero.',
  cash_custody_turn: 'El turno ya no está abierto. No se movió dinero.',
  cash_custody_float_open_turn: 'La caja ya tiene un turno abierto: el efectivo debe pasar por ese turno.',
  cash_custody_holder: 'La custodia o caja no está disponible en esta sucursal.',
  cash_custody_destination: 'Elige un destino activo distinto del origen.',
  cash_custody_transfer_state: 'El traslado ya fue recibido o rechazado. Consulta su estado actual.',
  cash_custody_handover_turn: 'Solo se entrega un turno físico terminado.',
}
async function guarded(fn) {
  try { return await fn() } catch (error) {
    const found = Object.keys(DB_ERRORS).find(code => String(error.message).includes(code))
    if (found) fail(409, found.toUpperCase(), DB_ERRORS[found])
    if (error.code === 'P2010' && error.meta?.code === '23505') fail(409, 'CASH_CUSTODY_CONFLICT', 'Este registro ya existe. Consulta su estado actual.')
    throw error
  }
}
async function cashMethod(tx, companyId) {
  const choices = await require('../../services/paymentMethods/access').listPaymentMethodChoices(tx, companyId)
  const method = choices.find(m => m.origin === 'BASIC' && m.settlement_kind === 'CASH' && !m.is_credit) || choices.find(m => m.settlement_kind === 'CASH' && !m.is_credit)
  if (!method) fail(409, 'CASH_CUSTODY_METHOD', 'Activa un medio clasificado como efectivo antes de mover dinero.')
  return method
}
async function currency(tx, companyId) {
  const row = await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: companyId, key: 'currency_code' } } })
  if (!row?.value) fail(409, 'CASH_CUSTODY_CURRENCY', 'Configura la moneda de la empresa antes de mover efectivo.')
  return row.value
}
async function lockCustody(tx, scope, custodyId) {
  const [row] = await tx.$queryRaw`SELECT * FROM cash_custodies WHERE id=${custodyId}::uuid AND company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid FOR UPDATE`
  if (!row) fail(404, 'CASH_CUSTODY_NOT_FOUND', 'Custodia no disponible en la sucursal seleccionada')
  return row
}
async function lockRegister(tx, scope, registerId) {
  const [row] = await tx.$queryRaw`SELECT r.* FROM cash_registers r JOIN branches b ON b.id=r.branch_id
    WHERE r.id=${registerId}::uuid AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid FOR UPDATE OF r`
  if (!row) fail(404, 'CASH_REGISTER_NOT_FOUND', 'Caja no disponible en la sucursal seleccionada')
  if (row.money_event_version !== 1 || row.kind !== 'PHYSICAL') fail(409, 'CASH_CUSTODY_REGISTER', 'La caja debe ser física y con libro de movimientos habilitado')
  return row
}
const openSessionOf = async (tx, registerId) => (await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE cash_register_id=${registerId}::uuid AND status='OPEN'`)[0]?.id || null
async function balance(tx, { custodyId = null, registerId = null }) {
  const [row] = await tx.$queryRaw`SELECT cash_custody_balance(${custodyId}::uuid,${registerId}::uuid)::text AS amount`
  return D(row.amount)
}
async function insertEntry(tx, entry) {
  const row = { id: randomUUID(), custody_id: null, cash_register_id: null, cash_register_session_id: null, payment_method_id: null, payment_method_name: null, transfer_id: null, handover_id: null, opening_session_id: null, ...entry }
  await guarded(() => tx.$executeRaw`INSERT INTO cash_custody_entries(id,company_id,branch_id,holder_kind,custody_id,cash_register_id,cash_register_session_id,direction,amount,currency_code,actor_id,payment_method_id,payment_method_name,leg,transfer_id,handover_id,opening_session_id)
    SELECT x.id,x.company_id,x.branch_id,x.holder_kind,x.custody_id,x.cash_register_id,x.cash_register_session_id,x.direction,x.amount,x.currency_code,x.actor_id,x.payment_method_id,x.payment_method_name,x.leg,x.transfer_id,x.handover_id,x.opening_session_id
    FROM json_populate_record(NULL::cash_custody_entries,${JSON.stringify(row)}::json) x`)
  return row
}
// Asiento dentro de un turno abierto: es dinero de ese turno y entra a su libro con el escritor canónico.
async function sessionEntry(tx, scope, session, entry) {
  const method = await cashMethod(tx, scope.companyId)
  const row = await insertEntry(tx, { ...entry, holder_kind: 'SESSION', cash_register_id: session.cash_register_id, cash_register_session_id: session.id, payment_method_id: method.id, payment_method_name: method.name })
  await guarded(() => require('./events').recordMoneyEvent(tx, scope, { session, sourceType: 'CUSTODY_ENTRY', sourceId: row.id }))
  return row
}
const transferSelect = Prisma.sql`SELECT t.*,s.name AS sender_name,rv.name AS receiver_name,oc.name AS origin_custody_name,orr.name AS origin_register_name,
  dc.name AS destination_custody_name,dr.name AS destination_register_name,ret.id AS return_transfer_id
  FROM cash_custody_transfers t JOIN users s ON s.id=t.sender_id LEFT JOIN users rv ON rv.id=t.receiver_id
  LEFT JOIN cash_custodies oc ON oc.id=t.origin_custody_id LEFT JOIN cash_registers orr ON orr.id=t.origin_register_id
  LEFT JOIN cash_custodies dc ON dc.id=t.destination_custody_id LEFT JOIN cash_registers dr ON dr.id=t.destination_register_id
  LEFT JOIN cash_custody_transfers ret ON ret.returns_transfer_id=t.id`
async function ownerSelfReview(tx, companyId) {
  if (!await require('./policy').reviewAvailable(tx)) return false
  const [row] = await tx.$queryRaw`SELECT owner_self_review FROM cash_difference_policies WHERE company_id=${companyId}::uuid AND branch_id IS NULL`
  return row?.owner_self_review === true
}
async function blindFor(db, scope) {
  if (scope.canOperateTeam || scope.isAdmin || !await require('./policy').reviewAvailable(db)) return false
  return (await require('./policy').resolvePolicy(db, scope.companyId, scope.branchId)).blind_count === true
}
const transferDto = row => row && ({ ...row, self_received: !!row.receiver_id && row.receiver_id === row.sender_id, amount: D(row.amount).toFixed(2), received_amount: row.received_amount == null ? null : D(row.received_amount).toFixed(2),
  difference: row.received_amount == null ? null : D(row.received_amount).sub(D(row.amount)).toFixed(2),
  created_at: new Date(row.created_at).toISOString(), received_at: row.received_at ? new Date(row.received_at).toISOString() : null })
async function readTransfer(db, scope, transferId) {
  const [row] = await db.$queryRaw(Prisma.sql`${transferSelect} WHERE t.id=${transferId}::uuid AND t.company_id=${scope.companyId}::uuid AND t.branch_id=${scope.branchId}::uuid`)
  return row || null
}
async function attempt(tx, scope, table, requestKey) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-custody', table, scope.companyId, scope.branchId, scope.userId, requestKey])},0))::text`
  const actor = table === 'cash_turn_handovers' ? Prisma.sql`actor_id` : Prisma.sql`sender_id`
  const [old] = await tx.$queryRaw`SELECT id,request_hash FROM ${Prisma.raw(table)} WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND ${actor}=${scope.userId}::uuid AND request_key=${requestKey}::uuid`
  return old || null
}

// ---- Envío ---------------------------------------------------------------------------------------
function parseSend(raw) {
  strict(raw, ['requestKey', 'origin', 'destination', 'amount', 'reason', 'reference'])
  const origin = strict(raw.origin, ['kind', 'sessionId', 'custodyId', 'registerId']), destination = strict(raw.destination, ['kind', 'custodyId', 'registerId'])
  const parsedOrigin = origin.kind === 'SESSION' ? { kind: 'SESSION', sessionId: id(origin.sessionId, 'Turno') } : origin.kind === 'CUSTODY' ? { kind: 'CUSTODY', custodyId: id(origin.custodyId, 'Custodia') }
    : origin.kind === 'FLOAT' ? { kind: 'FLOAT', registerId: id(origin.registerId, 'Caja') } : fail(400, 'CASH_CUSTODY_ORIGIN', 'Elige de dónde sale el efectivo')
  const parsedDestination = destination.kind === 'CUSTODY' ? { kind: 'CUSTODY', custodyId: id(destination.custodyId, 'Custodia') } : destination.kind === 'REGISTER' ? { kind: 'REGISTER', registerId: id(destination.registerId, 'Caja') } : fail(400, 'CASH_CUSTODY_DESTINATION', 'Elige a dónde va el efectivo')
  return { requestKey: id(raw.requestKey, 'Intento'), origin: parsedOrigin, destination: parsedDestination, amount: money(raw.amount), reason: text(raw.reason, 500), reference: text(raw.reference, 255, false) }
}
async function sendTransfer(tx, scope, raw) {
  requireScope(scope)
  if (!scope.canOperateOwn && !scope.canOperateTeam && !scope.isAdmin) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para entregar efectivo')
  const input = parseSend(raw); await requireAvailable(tx)
  const { requestKey, ...intent } = input, requestHash = hash({ action: 'send', ...intent })
  const old = await attempt(tx, scope, 'cash_custody_transfers', requestKey)
  if (old) { if (old.request_hash !== requestHash) fail(409, 'CASH_CUSTODY_ATTEMPT_CONFLICT', 'Este intento corresponde a otro traslado; recupera su resultado antes de cambiarlo'); return { replayed: true, transfer: transferDto(await readTransfer(tx, scope, old.id)) } }
  const team = scope.canOperateTeam || scope.isAdmin, code = await currency(tx, scope.companyId)
  const transfer = { id: randomUUID(), origin_custody_id: null, origin_register_id: null, origin_session_id: null, destination_custody_id: null, destination_register_id: null }
  let session = null
  if (input.origin.kind === 'SESSION') {
    session = await lockScopedSession(tx, scope, input.origin.sessionId)
    if (session.opened_by_id !== scope.userId && !session.actor_participant && !team) fail(403, 'CASH_SESSION_OTHER_USER', 'Solo puedes entregar efectivo de tu propio turno.')
    assertSessionOperation(session, scope, { settlementKind: 'CASH', allowOtherUser: team })
    if (session.money_event_version !== 1 || session.register_type !== 'PHYSICAL') fail(409, 'CASH_CUSTODY_REGISTER', 'El turno debe ser físico y con libro de movimientos habilitado')
    Object.assign(transfer, { origin_register_id: session.cash_register_id, origin_session_id: session.id })
  } else {
    if (!team) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'Entregar desde una custodia o un fondo retenido requiere autoridad del equipo')
    if (input.origin.kind === 'CUSTODY') { await lockCustody(tx, scope, input.origin.custodyId); transfer.origin_custody_id = input.origin.custodyId }
    else {
      await lockRegister(tx, scope, input.origin.registerId)
      if (await openSessionOf(tx, input.origin.registerId)) fail(409, 'CASH_CUSTODY_FLOAT_OPEN_TURN', 'La caja tiene un turno abierto: entrega desde ese turno, no desde su fondo retenido.')
      transfer.origin_register_id = input.origin.registerId
    }
  }
  if (input.destination.kind === 'CUSTODY') { const c = await lockCustody(tx, scope, input.destination.custodyId); if (!c.active) fail(409, 'CASH_CUSTODY_INACTIVE', 'La custodia de destino está inactiva'); transfer.destination_custody_id = c.id }
  else { await lockRegister(tx, scope, input.destination.registerId); transfer.destination_register_id = input.destination.registerId }
  const available = session ? null : await balance(tx, { custodyId: transfer.origin_custody_id, registerId: transfer.origin_custody_id ? null : transfer.origin_register_id })
  if (available && available.lt(input.amount)) fail(409, 'CASH_CUSTODY_INSUFFICIENT', `El origen tiene ${available.toFixed(2)} disponibles. No se movió dinero.`)
  await guarded(() => tx.$executeRaw`INSERT INTO cash_custody_transfers(id,company_id,branch_id,sender_id,request_key,request_hash,origin_kind,origin_custody_id,origin_register_id,origin_session_id,destination_kind,destination_custody_id,destination_register_id,amount,currency_code,reason,reference)
    VALUES(${transfer.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${scope.userId}::uuid,${requestKey}::uuid,${requestHash},${input.origin.kind},${transfer.origin_custody_id}::uuid,${transfer.origin_register_id}::uuid,${transfer.origin_session_id}::uuid,
     ${input.destination.kind},${transfer.destination_custody_id}::uuid,${transfer.destination_register_id}::uuid,${input.amount}::numeric,${code},${input.reason},${input.reference})`)
  const leg = { company_id: scope.companyId, branch_id: scope.branchId, direction: 'OUT', amount: input.amount, currency_code: code, actor_id: scope.userId, leg: 'SEND', transfer_id: transfer.id }
  if (session) await sessionEntry(tx, scope, session, leg)
  else await insertEntry(tx, { ...leg, holder_kind: transfer.origin_custody_id ? 'CUSTODY' : 'FLOAT', custody_id: transfer.origin_custody_id, cash_register_id: transfer.origin_custody_id ? null : transfer.origin_register_id })
  return { replayed: false, transfer: transferDto(await readTransfer(tx, scope, transfer.id)) }
}

// ---- Recepción y rechazo -------------------------------------------------------------------------
async function lockDestination(tx, scope, transfer) {
  if (transfer.destination_kind === 'CUSTODY') { await lockCustody(tx, scope, transfer.destination_custody_id); return null }
  await lockRegister(tx, scope, transfer.destination_register_id)
  const sessionId = await openSessionOf(tx, transfer.destination_register_id)
  if (!sessionId) return null
  // Si el turno se cerró mientras se esperaba su bloqueo, lo recibido va al fondo retenido, nunca al turno cerrado.
  const session = await lockScopedSession(tx, scope, sessionId)
  return session.status === 'OPEN' ? session : null
}
async function lockedTransfer(tx, scope, transferId) {
  const [row] = await tx.$queryRaw`SELECT * FROM cash_custody_transfers WHERE id=${transferId}::uuid AND company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid FOR UPDATE`
  if (!row) fail(404, 'CASH_CUSTODY_TRANSFER_NOT_FOUND', 'Traslado no disponible en la sucursal seleccionada')
  return row
}
async function receiveTransfer(tx, scope, transferId, raw) {
  requireScope(scope)
  if (!scope.canReceive && !scope.isAdmin) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para recibir efectivo')
  strict(raw, ['receivedAmount', 'reason'])
  const received = money(raw.receivedAmount, true), reason = text(raw.reason, 500, false); await requireAvailable(tx)
  const draft = await readTransfer(tx, scope, id(transferId, 'Traslado'))
  if (!draft) fail(404, 'CASH_CUSTODY_TRANSFER_NOT_FOUND', 'Traslado no disponible en la sucursal seleccionada')
  const session = await lockDestination(tx, scope, draft), transfer = await lockedTransfer(tx, scope, draft.id)
  // Reintento de la misma recepción: devuelve el resultado guardado sin acreditar otra vez.
  if (transfer.status === 'RECEIVED' && transfer.receiver_id === scope.userId && D(transfer.received_amount).eq(received)) return { replayed: true, transfer: transferDto(await readTransfer(tx, scope, transfer.id)) }
  if (transfer.status !== 'PENDING') fail(409, 'CASH_CUSTODY_TRANSFER_STATE', 'El traslado ya fue recibido o rechazado. Consulta su estado actual.')
  // 3C: el dueño que opera solo (excepción de la política de empresa) recibe lo propio; queda visible como receptor = emisor.
  const self = transfer.sender_id === scope.userId
  if (self && !await ownerSelfReview(tx, scope.companyId)) fail(403, 'CASH_CUSTODY_SAME_PERSON', 'Otra persona autorizada debe recibir el efectivo que entregaste.')
  if (!D(received).eq(D(transfer.amount)) && !reason) fail(400, 'CASH_CUSTODY_DIFFERENCE_REASON', 'Explica la diferencia entre lo enviado y lo recibido.')
  if (session && session.opened_by_id !== scope.userId && !session.actor_participant && !scope.canOperateTeam && !scope.isAdmin) fail(403, 'CASH_SESSION_OTHER_USER', 'El efectivo entra al turno abierto de esa caja: debe recibirlo su responsable o un encargado.')
  await guarded(() => tx.$executeRaw`UPDATE cash_custody_transfers SET status='RECEIVED',received_amount=${received}::numeric,receiver_id=${scope.userId}::uuid,receipt_reason=${reason} WHERE id=${transfer.id}::uuid`)
  if (D(received).gt(0)) {
    const leg = { company_id: scope.companyId, branch_id: scope.branchId, direction: 'IN', amount: received, currency_code: transfer.currency_code, actor_id: scope.userId, leg: 'RECEIVE', transfer_id: transfer.id }
    if (session) { assertSessionOperation(session, scope, { settlementKind: 'CASH', allowOtherUser: scope.canOperateTeam === true }); await sessionEntry(tx, scope, session, leg) }
    else await insertEntry(tx, { ...leg, holder_kind: transfer.destination_kind === 'CUSTODY' ? 'CUSTODY' : 'FLOAT', custody_id: transfer.destination_custody_id, cash_register_id: transfer.destination_register_id })
  }
  return { replayed: false, transfer: transferDto(await readTransfer(tx, scope, transfer.id)) }
}
async function rejectTransfer(tx, scope, transferId, raw) {
  requireScope(scope)
  if (!scope.canReceive && !scope.isAdmin) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para recibir efectivo')
  strict(raw, ['reason'])
  const reason = text(raw.reason, 500); await requireAvailable(tx)
  const draft = await readTransfer(tx, scope, id(transferId, 'Traslado'))
  if (!draft) fail(404, 'CASH_CUSTODY_TRANSFER_NOT_FOUND', 'Traslado no disponible en la sucursal seleccionada')
  await lockDestination(tx, scope, draft)
  const transfer = await lockedTransfer(tx, scope, draft.id)
  if (transfer.status === 'REJECTED' && transfer.receiver_id === scope.userId) return { replayed: true, transfer: transferDto(await readTransfer(tx, scope, transfer.id)) }
  if (transfer.status !== 'PENDING') fail(409, 'CASH_CUSTODY_TRANSFER_STATE', 'El traslado ya fue recibido o rechazado. Consulta su estado actual.')
  if (transfer.sender_id === scope.userId) fail(403, 'CASH_CUSTODY_SAME_PERSON', 'Otra persona autorizada debe recibir o rechazar el efectivo que entregaste.')
  if (transfer.origin_kind === 'RETURN') fail(409, 'CASH_CUSTODY_RETURN_REJECT', 'Una devolución no se rechaza: recíbela indicando cuánto llegó.')
  await guarded(() => tx.$executeRaw`UPDATE cash_custody_transfers SET status='REJECTED',receiver_id=${scope.userId}::uuid,receipt_reason=${reason} WHERE id=${transfer.id}::uuid`)
  // Devolución física: el dinero vuelve a su origen como un traslado pendiente, sin debitar a nadie.
  const back = transfer.origin_kind === 'CUSTODY' ? { kind: 'CUSTODY', custody: transfer.origin_custody_id, register: null } : { kind: 'REGISTER', custody: null, register: transfer.origin_register_id }
  await guarded(() => tx.$executeRaw`INSERT INTO cash_custody_transfers(company_id,branch_id,sender_id,request_key,request_hash,origin_kind,destination_kind,destination_custody_id,destination_register_id,amount,currency_code,reason,returns_transfer_id)
    VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${scope.userId}::uuid,${randomUUID()}::uuid,${hash({ action: 'return', of: transfer.id })},'RETURN',${back.kind},${back.custody}::uuid,${back.register}::uuid,${transfer.amount}::numeric,${transfer.currency_code},${'Devolución: ' + reason.slice(0, 480)},${transfer.id}::uuid)`)
  return { replayed: false, transfer: transferDto(await readTransfer(tx, scope, transfer.id)) }
}

// ---- Entrega de turno ----------------------------------------------------------------------------
async function expectedCash(tx, session) {
  const [row] = await tx.$queryRaw`SELECT (${session.opening_float}::numeric+coalesce(sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END),0))::text AS amount
    FROM cash_money_events WHERE cash_register_session_id=${session.id}::uuid AND settlement_kind='CASH'`
  return D(row.amount).toFixed(2)
}
async function handoverTurn(tx, scope, sessionId, raw) {
  requireScope(scope)
  if (!scope.canOperateOwn && !scope.canOperateTeam && !scope.isAdmin) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para entregar el turno')
  strict(raw, ['requestKey', 'deliveredAmount', 'retainedAmount', 'destinationCustodyId', 'notes'])
  const input = { requestKey: id(raw.requestKey, 'Intento'), sessionId: id(sessionId, 'Turno'), delivered: money(raw.deliveredAmount, true), retained: money(raw.retainedAmount, true),
    destinationCustodyId: raw.destinationCustodyId == null ? null : id(raw.destinationCustodyId, 'Custodia'), notes: text(raw.notes, 500, false) }
  if (D(input.delivered).gt(0) !== !!input.destinationCustodyId) fail(400, 'CASH_CUSTODY_DESTINATION', 'Elige la custodia que recibe lo entregado, o entrega 0.')
  await requireAvailable(tx)
  const { requestKey, ...intent } = input, requestHash = hash({ action: 'handover', ...intent })
  const old = await attempt(tx, scope, 'cash_turn_handovers', requestKey)
  if (old) { if (old.request_hash !== requestHash) fail(409, 'CASH_CUSTODY_ATTEMPT_CONFLICT', 'Este intento corresponde a otra entrega; recupera su resultado antes de cambiarla'); return { replayed: true, handover: await readHandover(tx, scope, input.sessionId) } }
  const session = await lockScopedSession(tx, scope, input.sessionId)
  if (session.opened_by_id !== scope.userId && !scope.canOperateTeam && !scope.isAdmin) fail(403, 'CASH_SESSION_OTHER_USER', 'Solo puedes entregar tu propio turno.')
  if (session.status !== 'CLOSED') fail(409, 'CASH_CUSTODY_HANDOVER_TURN', 'Termina el turno antes de entregar su efectivo.')
  if (session.money_event_version !== 1 || session.register_type !== 'PHYSICAL') fail(409, 'CASH_CUSTODY_REGISTER', 'El turno debe ser físico y con libro de movimientos habilitado')
  if (await readHandover(tx, scope, session.id)) fail(409, 'CASH_CUSTODY_HANDOVER_DONE', 'Este turno ya fue entregado. Consulta la entrega registrada.')
  await lockRegister(tx, scope, session.cash_register_id)
  if (D(input.retained).gt(0) && await openSessionOf(tx, session.cash_register_id)) fail(409, 'CASH_CUSTODY_FLOAT_OPEN_TURN', 'La caja ya abrió otro turno: entrega todo el efectivo a una custodia.')
  if (input.destinationCustodyId) { const c = await lockCustody(tx, scope, input.destinationCustodyId); if (!c.active) fail(409, 'CASH_CUSTODY_INACTIVE', 'La custodia de destino está inactiva') }
  const handoverId = randomUUID(), expected = await expectedCash(tx, session)
  await guarded(() => tx.$executeRaw`INSERT INTO cash_turn_handovers(id,company_id,branch_id,cash_register_id,cash_register_session_id,actor_id,request_key,request_hash,delivered_amount,retained_amount,expected_cash,currency_code,destination_custody_id,notes)
    VALUES(${handoverId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${session.cash_register_id}::uuid,${session.id}::uuid,${scope.userId}::uuid,${requestKey}::uuid,${requestHash},${input.delivered}::numeric,${input.retained}::numeric,${expected}::numeric,${session.currency_code},${input.destinationCustodyId}::uuid,${input.notes})`)
  if (D(input.retained).gt(0)) await insertEntry(tx, { company_id: scope.companyId, branch_id: scope.branchId, holder_kind: 'FLOAT', cash_register_id: session.cash_register_id, direction: 'IN', amount: input.retained, currency_code: session.currency_code, actor_id: scope.userId, leg: 'RETAIN', handover_id: handoverId })
  if (D(input.delivered).gt(0)) await guarded(() => tx.$executeRaw`INSERT INTO cash_custody_transfers(company_id,branch_id,sender_id,request_key,request_hash,origin_kind,origin_register_id,origin_session_id,destination_kind,destination_custody_id,amount,currency_code,reason,handover_id)
    VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${scope.userId}::uuid,${randomUUID()}::uuid,${hash({ action: 'handover-delivery', of: handoverId })},'HANDOVER',${session.cash_register_id}::uuid,${session.id}::uuid,'CUSTODY',${input.destinationCustodyId}::uuid,${input.delivered}::numeric,${session.currency_code},'Entrega de turno',${handoverId}::uuid)`)
  return { replayed: false, handover: await readHandover(tx, scope, session.id) }
}
async function readHandover(db, scope, sessionId) {
  const [row] = await db.$queryRaw`SELECT h.*,u.name AS actor_name,c.name AS destination_custody_name,t.id AS transfer_id,t.status AS transfer_status FROM cash_turn_handovers h JOIN users u ON u.id=h.actor_id
    LEFT JOIN cash_custodies c ON c.id=h.destination_custody_id LEFT JOIN cash_custody_transfers t ON t.handover_id=h.id
    WHERE h.cash_register_session_id=${sessionId}::uuid AND h.company_id=${scope.companyId}::uuid AND h.branch_id=${scope.branchId}::uuid`
  if (!row) return null
  const counted = D(row.delivered_amount).add(D(row.retained_amount)), expected = row.expected_cash == null || await blindFor(db, scope) ? null : D(row.expected_cash)
  // Diferencia informativa: su revisión y aceptación pertenecen al arqueo (3C); con conteo ciego no se muestra a quien no es encargado.
  return { ...row, delivered_amount: D(row.delivered_amount).toFixed(2), retained_amount: D(row.retained_amount).toFixed(2), expected_cash: expected?.toFixed(2) ?? null,
    difference: expected ? counted.sub(expected).toFixed(2) : null, created_at: new Date(row.created_at).toISOString() }
}

// ---- Apertura con fondo heredado -----------------------------------------------------------------
// Se llama con la caja ya bloqueada y la sesión recién insertada: consume todo el fondo retenido una sola vez.
async function inheritOpeningFloat(tx, scope, register, session) {
  if (!await custodyAvailable(tx)) return null
  const inherited = await balance(tx, { registerId: register.id })
  if (!inherited.gt(0)) return null
  await tx.$executeRaw`UPDATE cash_register_sessions SET opening_inherited_amount=${inherited.toFixed(2)}::numeric WHERE id=${session.id}::uuid`
  await insertEntry(tx, { company_id: scope.companyId, branch_id: scope.branchId, holder_kind: 'FLOAT', cash_register_id: register.id, direction: 'OUT', amount: inherited.toFixed(2), currency_code: session.currency_code, actor_id: scope.userId, leg: 'OPENING', opening_session_id: session.id })
  return inherited.toFixed(2)
}
async function registerFloat(db, scope, registerId) {
  requireScope(scope)
  if (!await custodyAvailable(db)) return { available: false, amount: '0.00' }
  const [row] = await db.$queryRaw`SELECT cash_custody_balance(NULL,r.id)::text AS amount,(SELECT u.name FROM cash_custody_entries e JOIN users u ON u.id=e.actor_id
      WHERE e.holder_kind='FLOAT' AND e.cash_register_id=r.id AND e.direction='IN' ORDER BY e.created_at DESC LIMIT 1) AS last_actor_name
    FROM cash_registers r JOIN branches b ON b.id=r.branch_id WHERE r.id=${id(registerId, 'Caja')}::uuid AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid`
  if (!row) fail(404, 'CASH_REGISTER_NOT_FOUND', 'Caja no disponible en la sucursal seleccionada')
  return { available: true, amount: D(row.amount).toFixed(2), lastActorName: row.last_actor_name || null }
}

// ---- Custodias y lecturas ------------------------------------------------------------------------
const viewer = scope => { if (!scope.isAdmin && !scope.canView && !scope.canManage && !scope.canOperateOwn && !scope.canOperateTeam && !scope.canReceive) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para consultar custodias') }
async function listCustodies(db, scope) {
  requireScope(scope); viewer(scope); await requireAvailable(db)
  const rows = await db.$queryRaw`SELECT c.id,c.name,c.currency_code,c.active,cash_custody_balance(c.id,NULL)::numeric(14,2)::text AS balance,
    (SELECT count(*)::int FROM cash_custody_transfers t WHERE t.destination_custody_id=c.id AND t.status='PENDING') AS pending_in
    FROM cash_custodies c WHERE c.company_id=${scope.companyId}::uuid AND c.branch_id=${scope.branchId}::uuid ORDER BY c.active DESC,lower(c.name)`
  return rows
}
async function createCustody(tx, scope, raw) {
  requireScope(scope)
  if (!scope.canManage && !scope.isAdmin) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para configurar custodias')
  strict(raw, ['name']); const name = text(raw.name, 120); await requireAvailable(tx)
  const code = await currency(tx, scope.companyId), newId = randomUUID()
  try {
    await tx.$executeRaw`INSERT INTO cash_custodies(id,company_id,branch_id,name,currency_code,created_by_id) VALUES(${newId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${name},${code},${scope.userId}::uuid)`
  } catch (error) { if (error.code === 'P2010' && error.meta?.code === '23505') fail(409, 'CASH_CUSTODY_NAME', 'Ya existe una custodia con ese nombre en esta sucursal.'); throw error }
  return (await listCustodies(tx, { ...scope, canView: true })).find(c => c.id === newId)
}
async function setCustodyActive(tx, scope, custodyId, raw) {
  requireScope(scope)
  if (!scope.canManage && !scope.isAdmin) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para configurar custodias')
  strict(raw, ['active']); if (typeof raw.active !== 'boolean') fail(400, 'CASH_CUSTODY_INVALID', 'Indica si la custodia queda activa')
  await requireAvailable(tx); const row = await lockCustody(tx, scope, id(custodyId, 'Custodia'))
  if (!raw.active) {
    // Desactivar no puede dejar dinero sin responsable: primero se entrega su saldo y sus pendientes.
    if ((await balance(tx, { custodyId: row.id })).gt(0)) fail(409, 'CASH_CUSTODY_BALANCE', 'Entrega el saldo de esta custodia antes de desactivarla.')
    const [pending] = await tx.$queryRaw`SELECT count(*)::int AS n FROM cash_custody_transfers WHERE destination_custody_id=${row.id}::uuid AND status='PENDING'`
    if (pending.n) fail(409, 'CASH_CUSTODY_PENDING', 'Hay traslados pendientes hacia esta custodia. Recíbelos o recházalos antes de desactivarla.')
  }
  await tx.$executeRaw`UPDATE cash_custodies SET active=${raw.active},updated_at=clock_timestamp() WHERE id=${row.id}::uuid`
  return (await listCustodies(tx, { ...scope, canView: true })).find(c => c.id === row.id)
}
async function listTransfers(db, scope, { status, page = 1, pageSize = 20, search = '', direction } = {}) {
  requireScope(scope); viewer(scope); await requireAvailable(db)
  if (status && !['PENDING', 'RECEIVED', 'REJECTED'].includes(status) || !Number.isSafeInteger(Number(page)) || Number(page) < 1 || !Number.isSafeInteger(Number(pageSize)) || Number(pageSize) < 1 || Number(pageSize) > 50
    || typeof search !== 'string' || search.length > 100 || direction && direction !== 'to_receive') fail(400, 'CASH_CUSTODY_FILTER', 'Revisa los filtros de traslados')
  const term = search.trim() && '%' + search.trim() + '%'
  const where = Prisma.sql`t.company_id=${scope.companyId}::uuid AND t.branch_id=${scope.branchId}::uuid
    ${status ? Prisma.sql`AND t.status=${status}` : Prisma.empty}
    ${direction === 'to_receive' ? Prisma.sql`AND t.status='PENDING' AND t.sender_id<>${scope.userId}::uuid` : Prisma.empty}
    ${term ? Prisma.sql`AND (t.reason ILIKE ${term} OR s.name ILIKE ${term} OR coalesce(oc.name,orr.name,'') ILIKE ${term} OR coalesce(dc.name,dr.name,'') ILIKE ${term})` : Prisma.empty}`
  const rows = await db.$queryRaw(Prisma.sql`${transferSelect} WHERE ${where} ORDER BY t.created_at DESC,t.id DESC LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`)
  const [count] = await db.$queryRaw(Prisma.sql`SELECT count(*)::int AS n FROM cash_custody_transfers t JOIN users s ON s.id=t.sender_id LEFT JOIN cash_custodies oc ON oc.id=t.origin_custody_id
    LEFT JOIN cash_registers orr ON orr.id=t.origin_register_id LEFT JOIN cash_custodies dc ON dc.id=t.destination_custody_id LEFT JOIN cash_registers dr ON dr.id=t.destination_register_id WHERE ${where}`)
  // Métricas de la sucursal, independientes del filtro: lo que espera recepción y el faltante acumulado.
  const [summary] = await db.$queryRaw`SELECT count(*) FILTER (WHERE status='PENDING')::int AS pending,count(*) FILTER (WHERE status='PENDING' AND sender_id<>${scope.userId}::uuid)::int AS to_receive,
    round(coalesce(sum(amount-received_amount) FILTER (WHERE status='RECEIVED' AND received_amount<amount),0),2)::text AS shortage
    FROM cash_custody_transfers WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid`
  return { items: rows.map(transferDto), totalItems: count.n, page: Number(page), pageSize: Number(pageSize), totalPages: Math.max(1, Math.ceil(count.n / Number(pageSize))),
    summary: { pending: summary.pending, toReceive: summary.to_receive, shortage: D(summary.shortage).toFixed(2) } }
}
async function getTransfer(db, scope, transferId) {
  requireScope(scope); viewer(scope); await requireAvailable(db)
  const row = await readTransfer(db, scope, id(transferId, 'Traslado'))
  if (!row) fail(404, 'CASH_CUSTODY_TRANSFER_NOT_FOUND', 'Traslado no disponible en la sucursal seleccionada')
  return transferDto(row)
}
const handoverSessionSelect = Prisma.sql`SELECT s.id,s.status,s.cash_register_id,s.opened_by_id,s.opened_at,s.closed_at,s.opening_float::text AS opening_float,s.currency_code,s.business_timezone,
  s.money_event_version,s.register_type,s.operation_mode,r.name AS register_name,u.name AS responsible_name
  FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id JOIN users u ON u.id=s.opened_by_id`
async function handoverContext(db, scope, sessionId) {
  requireScope(scope); viewer(scope); await requireAvailable(db)
  const [session] = await db.$queryRaw(Prisma.sql`${handoverSessionSelect} WHERE s.id=${id(sessionId, 'Turno')}::uuid AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid`)
  if (!session || session.opened_by_id !== scope.userId && !scope.canOperateTeam && !scope.canView && !scope.isAdmin) fail(404, 'CASH_SESSION_NOT_FOUND', 'Turno no encontrado en la sucursal activa')
  const handover = await readHandover(db, scope, session.id)
  const eligible = session.money_event_version === 1 && session.register_type === 'PHYSICAL'
  return { session: { ...session, opening_float: D(session.opening_float).toFixed(2), opened_at: new Date(session.opened_at).toISOString(), closed_at: session.closed_at ? new Date(session.closed_at).toISOString() : null },
    // 3C conteo ciego: lo esperado solo lo ve un encargado.
    eligible, handover, expectedCash: eligible && session.status === 'CLOSED' && !await blindFor(db, scope) ? await expectedCash(db, { id: session.id, opening_float: session.opening_float }) : null,
    registerHasOpenTurn: !!await openSessionOf(db, session.cash_register_id), custodies: (await listCustodies(db, { ...scope, canView: true })).filter(c => c.active),
    canHandover: eligible && session.status === 'CLOSED' && !handover && (session.opened_by_id === scope.userId && scope.canOperateOwn || scope.canOperateTeam || scope.isAdmin) }
}
async function pendingHandovers(db, scope) {
  requireScope(scope)
  if (!scope.canOperateOwn && !scope.canOperateTeam && !scope.isAdmin) return []
  if (!await custodyAvailable(db)) return []
  const rows = await db.$queryRaw(Prisma.sql`${handoverSessionSelect} WHERE r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND s.status='CLOSED'
    AND s.money_event_version=1 AND s.register_type='PHYSICAL'
    AND NOT EXISTS(SELECT 1 FROM cash_turn_handovers h WHERE h.cash_register_session_id=s.id)
    ${scope.canOperateTeam || scope.isAdmin ? Prisma.empty : Prisma.sql`AND s.opened_by_id=${scope.userId}::uuid`} ORDER BY s.closed_at DESC NULLS LAST LIMIT 20`)
  return rows.map(s => ({ ...s, opening_float: D(s.opening_float).toFixed(2), opened_at: new Date(s.opened_at).toISOString(), closed_at: s.closed_at ? new Date(s.closed_at).toISOString() : null }))
}
async function destinations(db, scope) {
  requireScope(scope); viewer(scope); await requireAvailable(db)
  const registers = await db.$queryRaw`SELECT r.id,r.name,(SELECT s.id FROM cash_register_sessions s WHERE s.cash_register_id=r.id AND s.status='OPEN') AS open_session_id,
    (SELECT s.opened_by_id FROM cash_register_sessions s WHERE s.cash_register_id=r.id AND s.status='OPEN') AS opened_by_id,
    (SELECT u.name FROM cash_register_sessions s JOIN users u ON u.id=s.opened_by_id WHERE s.cash_register_id=r.id AND s.status='OPEN') AS responsible_name,
    cash_custody_balance(NULL,r.id)::numeric(14,2)::text AS retained
    FROM cash_registers r JOIN branches b ON b.id=r.branch_id WHERE r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND r.active
     AND r.money_event_version=1 AND r.kind='PHYSICAL' ORDER BY lower(r.name)`
  for (const register of registers) if (register.open_session_id && await require('../../services/cashSharedSessions').available(db)) {
    const [s] = await db.$queryRaw`SELECT * FROM cash_register_sessions WHERE id=${register.open_session_id}::uuid`
    if (s?.operation_mode === 'SHARED') register.can_operate = (await require('../../services/cashSharedSessions').view(db,scope,s)).can_operate
  }
  return { custodies: await listCustodies(db, { ...scope, canView: true }), registers }
}

module.exports = { custodyAvailable, listCustodies, createCustody, setCustodyActive, listTransfers, getTransfer, handoverContext, pendingHandovers, destinations, sendTransfer, receiveTransfer, rejectTransfer, handoverTurn, inheritOpeningFloat, registerFloat, readTransfer, readHandover, transferDto, transferSelect, requireAvailable, requireScope, id, text, strict, guarded, lockCustody, currency, D }
