const { createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { fail, uuid, parseBooking, parseSession, parseEnroll, parseMove, parseTransition, object, text, quantity, requestKey } = require('./domain/validation')
const { appointmentWhere, assertAgendaWrite, assertAppointmentsEnabled, hasAgendaPermission,assertContactsIntegration } = require('./access')
const { availabilityContext } = require('./queries')
const { computeSlots, assigned } = require('./domain/availability')
const { occupiesSeat, nextBookingState, nextSessionState } = require('./domain/states')
const { commercialQuantity, lineSnapshot } = require('../../services/catalogItemRules')
const { presentBooking, presentSession, bookingInclude, sessionInclude } = require('./presentation')
const { resolveEffectiveModules } = require('../platform/registry')

async function withAgendaTransaction(db, companyId, work) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`appointments:${companyId}`},0))`
    return work(tx)
  }, { timeout: 30000, maxWait: 5000 })
}
async function withEmployeeAgendaLock(db, transactionDb, companyId, employeeIds, work) {
  const modules = await db.companyModule.findMany({ where: { company_id: companyId } })
  if (!resolveEffectiveModules(modules).find(m => m.code === 'appointments')?.effectiveEnabled) return work(db)
  // Free activities can occupy an employee through their user, without a provider record.
  return withAgendaTransaction(transactionDb, companyId, work)
}
function requireAction(scope, permission) {
  assertAgendaWrite(scope)
  if (!hasAgendaPermission(scope, permission)) fail(403, 'FORBIDDEN', 'No tienes permiso para realizar esta acción')
}
async function loadBooking(tx, scope, id) {
  uuid(id, 'bookingId')
  const row = await tx.appointmentBooking.findFirst({ where: { id, company_id: scope.companyId, session: appointmentWhere(scope) }, include: bookingInclude })
  if (!row) fail(404, 'NOT_FOUND', 'Reserva no encontrada')
  return row
}
async function loadSession(tx, scope, id) {
  uuid(id, 'sessionId')
  const row = await tx.appointmentSession.findFirst({ where: { id, ...appointmentWhere(scope), record_type: 'SCHEDULED_SERVICE' }, include: sessionInclude })
  if (!row) fail(404, 'NOT_FOUND', 'Sesión no encontrada')
  return row
}
async function history(tx, scope, row, action, before = null, after = null, reason = '') {
  return tx.appointmentHistory.create({ data: { company_id: scope.companyId, branch_id: row.branch_id, session_id: row.session_id || row.id,
    ...(row.session_id ? { booking_id: row.id } : {}), actor_id: scope.userId, action, ...(before ? { before } : {}), ...(after ? { after } : {}), reason } })
}
async function idempotent(tx, scope, operation, input, work) {
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const key = { company_id: scope.companyId, actor_id: scope.userId, operation, idempotency_key: input.idempotencyKey }
  const old = await tx.appointmentRequest.findUnique({ where: { company_id_actor_id_operation_idempotency_key: key } })
  let result
  if (old) {
    if (old.input_hash !== inputHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'Ese intento ya se usó con otros datos')
    result = { type: old.result_type, id: old.result_id }
  } else {
    result = await work()
    await tx.appointmentRequest.create({ data: { ...key, input_hash: inputHash, result_type: result.type, result_id: result.id } })
  }
  if (result.type === 'BOOKING') return presentBooking(await loadBooking(tx, scope, result.id), scope)
  if (result.type === 'SESSION') return presentSession(await loadSession(tx, scope, result.id), scope)
  if (result.type === 'ACTIVITY') return require('./activities').getActivity(tx,scope,result.id)
  if (result.type === 'ENGAGEMENT') return require('./commercialQueries').getEngagement(tx,scope,result.id)
  if (result.type === 'PAYMENT') return require('./engagementPayments').paymentResult(tx,scope,result.id)
  const wait = await tx.appointmentWaitlist.findFirst({ where: { id: result.id, company_id: scope.companyId, session: appointmentWhere(scope) }, select: { id: true, status: true, contact_id: true, booking_id: true } })
  if (!wait) fail(404, 'NOT_FOUND', 'Registro no encontrado')
  return { id: wait.id, status: wait.status, contactId: wait.contact_id, bookingId: wait.booking_id }
}
async function command(db, scope, permission, operation, input, work) {
  requireAction(scope, permission)
  return withAgendaTransaction(db, scope.companyId, async tx => {
    await assertAppointmentsEnabled(tx, scope)
    return idempotent(tx, scope, operation, input, () => work(tx, new Date()))
  })
}
function commercialSnapshot(product, quantity, currencyCode) {
  const snap = lineSnapshot(product), qty = commercialQuantity(quantity, product), price = new Prisma.Decimal(product.price)
  if (!price.isFinite() || price.lt(0)) fail(400, 'INVALID_PRICE', 'El servicio no tiene un precio válido')
  return { name: snap.item_name, unit: snap.unit_label, quantityDecimals: snap.quantity_decimals, quantity: qty.toString(), unitPrice: price.toFixed(2), total: price.mul(qty).toDecimalPlaces(2).toFixed(2), currencyCode }
}
async function contact(tx, scope, id) {
  await assertContactsIntegration(tx,scope)
  const row = await tx.supplier.findFirst({ where: { id, company_id: scope.companyId, deleted: false, estado: 1, party_type: 'CUSTOMER' }, select: { id: true } })
  if (!row) fail(400, 'INVALID_CONTACT', 'Selecciona un cliente activo de esta empresa')
}
async function expire(tx, scope, sessionId, now) {
  const rows = await tx.appointmentBooking.findMany({ where: { company_id: scope.companyId, session_id: sessionId, status: { in: ['HELD', 'PENDING'] }, expires_at: { lte: now } } })
  for (const row of rows) {
    await tx.appointmentBooking.update({ where: { id: row.id }, data: { status: 'EXPIRED', version: { increment: 1 } } })
    await history(tx, scope, row, 'EXPIRED', { status: row.status }, { status: 'EXPIRED' })
    await require('./engagementResolution').recordEngagementImpact(tx,scope,{bookingId:row.id,action:'EXPIRED',version:row.version})
  }
}
async function slotFor(tx, scope, productId, input, now, { excludeSessionId, profileOverride, scheduleGroup = false } = {}) {
  if (new Date(input.startsAt) <= now) fail(409, 'TIME_PASSED', 'Selecciona un horario futuro')
  const context = await availabilityContext(tx, scope, { productId, from: input.startsAt, to: new Date(new Date(input.startsAt).getTime() + 86400000).toISOString(), providerIds: input.providerIds, resourceIds: input.resourceIds,
    venue:input.venue,outboundMinutes:input.outboundMinutes,returnMinutes:input.returnMinutes }, { excludeSessionId, profileOverride })
  if(context.profile.schedulingStyle==='WORK') fail(400,'WORK_REQUIRES_ACTIVITY','Agenda este servicio como trabajo o evento completo')
  const slot=require('./serviceScheduling').assertServiceInterval(context,input,now,{scheduleGroup})
  return { context, slot }
}
async function assignments(tx, scope, sessionId, slot, replace = false) {
  for (const [model, key, ids] of [['appointmentSessionProvider', 'provider_id', slot.providerIds], ['appointmentSessionResource', 'resource_id', slot.resourceIds]]) {
    if (replace) await tx[model].deleteMany({ where: { session_id: sessionId, company_id: scope.companyId } })
    if (ids.length) await tx[model].createMany({ data: ids.map(id => ({ company_id: scope.companyId, session_id: sessionId, [key]: id })) })
  }
}
async function insertSession(tx, scope, productId, slot, profile, notes, capacity,location={}) {
  const row = await tx.appointmentSession.create({ data: { company_id: scope.companyId, branch_id: scope.branchId, product_id: productId,
    mode: profile.mode,venue:location.venue||{kind:'BRANCH'},outbound_minutes:location.outboundMinutes||0,return_minutes:location.returnMinutes||0,
    setup_minutes:profile.beforeMinutes,teardown_minutes:profile.afterMinutes,
    starts_at: new Date(slot.startsAt), ends_at: new Date(slot.endsAt), occupied_from: new Date(new Date(slot.startsAt).getTime() - (profile.beforeMinutes+(location.outboundMinutes||0)) * 60000),
    occupied_until: new Date(new Date(slot.endsAt).getTime() + (profile.afterMinutes+(location.returnMinutes||0)) * 60000), timezone: slot.timezone, capacity, policy_snapshot: {...profile,durationMinutes:(new Date(slot.endsAt)-new Date(slot.startsAt))/60000}, notes, created_by: scope.userId } })
  await assignments(tx, scope, row.id, slot)
  await history(tx, scope, row, 'CREATED', null, { status: 'SCHEDULED', startsAt: slot.startsAt })
  return row
}
async function insertBooking(tx, scope, session, product, input, now,options={}) {
  await contact(tx, scope, input.contactId)
  await expire(tx, scope, session.id, now)
  const occupied = await tx.appointmentBooking.findMany({ where: { company_id: scope.companyId, session_id: session.id } })
  if (occupied.filter(b => occupiesSeat(b, now)).length >= session.capacity) fail(409, 'SESSION_FULL', 'No quedan cupos disponibles')
  if (occupied.some(b => b.contact_id === input.contactId && occupiesSeat(b, now))) fail(409, 'DUPLICATE_BOOKING', 'El cliente ya está inscrito')
  const setting = await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: scope.companyId, key: 'currency_code' } } })
  let commercial = options.commercialSnapshot||commercialSnapshot(product, input.quantity, setting?.value || 'GTQ')
  const privateGroup=(session.engagement_schedules||[]).find(s=>s.kind==='SESSION')
  if(privateGroup){
    await require('./commercialQueries').getEngagement(tx,scope,privateGroup.engagement_id)
    commercial={...commercial,unitPrice:'0.00',total:'0.00',engagementId:privateGroup.engagement_id,includedInEngagement:true}
  }
  const manual = session.policy_snapshot.confirmation === 'MANUAL'
  const row = await tx.appointmentBooking.create({ data: { company_id: scope.companyId, branch_id: scope.branchId, session_id: session.id, contact_id: input.contactId,
    status: manual ? 'PENDING' : 'CONFIRMED', expires_at: manual ? new Date(Math.min(now.getTime() + 86400000, new Date(session.starts_at).getTime())) : null,
    quantity: commercial.quantity, commercial_snapshot: commercial, policy_snapshot: session.policy_snapshot, notes: input.notes, created_by: scope.userId } })
  await history(tx, scope, row, 'CREATED', null, { status: row.status })
  if(row.status==='CONFIRMED'&&!options.commercialSnapshot?.engagementId)
    await require('./commercialDrafts').ensureBookingCommercialDraft(tx,scope,{booking:{...row,session:{...session,engagement_schedules:session.engagement_schedules||[]},engagement_schedules:[]}})
  return { type: 'BOOKING', id: row.id }
}
async function createBooking(db, scope, raw) {
  const input = parseBooking(raw)
  return command(db, scope, 'appointments.create', 'CREATE_BOOKING', input, (tx,now)=>createBookingInTransaction(tx,scope,input,now))
}
async function createBookingInTransaction(tx,scope,input,now,options={}){
    const { context, slot } = await slotFor(tx, scope, input.productId, input, now)
    if (context.profile.mode !== 'INDIVIDUAL') fail(400, 'GROUP_REQUIRES_SESSION', 'Selecciona una sesión grupal para inscribir al cliente')
    const session = await insertSession(tx, scope, input.productId, slot, context.profile, '', 1,input)
    return insertBooking(tx, scope, session, context.product, input, now,options)
}
async function createSession(db, scope, raw) {
  const input = parseSession(raw)
  return command(db, scope, 'appointments.create', 'CREATE_SESSION', input, (tx,now)=>createSessionInTransaction(tx,scope,input,now))
}
async function createSessionInTransaction(tx,scope,input,now){
    const { context, slot } = await slotFor(tx, scope, input.productId, input, now, { scheduleGroup: true })
    if (context.profile.mode !== 'GROUP') fail(400, 'NOT_GROUP', 'Este servicio es de atención individual')
    if (input.capacity > slot.remaining) fail(400, 'INVALID_CAPACITY', 'El cupo supera el servicio o la capacidad del recurso')
    const row = await insertSession(tx, scope, input.productId, slot, context.profile, input.notes, input.capacity,input)
    return { type: 'SESSION', id: row.id }
}
async function enrollBooking(db, scope, sessionId, raw) {
  uuid(sessionId, 'sessionId')
  const input = { sessionId, ...parseEnroll(raw) }
  return command(db, scope, 'appointments.create', 'ENROLL', input, async (tx, now) => {
    return enroll(tx, scope, sessionId, input, now)
  })
}
async function enroll(tx, scope, sessionId, input, now) {
  const session = await loadSession(tx, scope, sessionId)
  if (session.mode !== 'GROUP' || session.status !== 'SCHEDULED' || session.starts_at <= now) fail(409, 'SESSION_UNAVAILABLE', 'La sesión ya no admite inscripciones')
  const context = await availabilityContext(tx, scope, { productId: session.product_id, from: session.starts_at.toISOString(), to: session.ends_at.toISOString(), providerIds: assigned(session, 'providers'), resourceIds: assigned(session, 'resources'),venue:session.venue,outboundMinutes:session.outbound_minutes,returnMinutes:session.return_minutes },{profileOverride:session.policy_snapshot})
  if (!computeSlots({ ...context, profile: { ...context.profile, mode: 'GROUP' }, now }).some(s => s.sessionId === sessionId)) fail(409, 'SESSION_UNAVAILABLE', 'Revisa el cupo y la disponibilidad de esta sesión')
  return insertBooking(tx, scope, session, context.product, input, now)
}
async function move(tx, scope, session, input, now) {
  if (session.status !== 'SCHEDULED' || session.starts_at <= now) fail(409, 'SESSION_STARTED', 'Una sesión iniciada no puede reprogramarse')
  const profile = { ...session.policy_snapshot, capacity: session.capacity }
  const { slot } = await slotFor(tx, scope, session.product_id, input, now, { excludeSessionId: session.id, profileOverride: profile, scheduleGroup: session.mode === 'GROUP' })
  if (slot.remaining < session.capacity) fail(409, 'INVALID_CAPACITY', 'El recurso de destino no admite el cupo de esta sesión')
  await tx.appointmentSession.update({ where: { id: session.id }, data: { starts_at: new Date(slot.startsAt), ends_at: new Date(slot.endsAt),policy_snapshot:{...profile,durationMinutes:(new Date(slot.endsAt)-new Date(slot.startsAt))/60000},
    venue:input.venue,outbound_minutes:input.outboundMinutes,return_minutes:input.returnMinutes,setup_minutes:profile.beforeMinutes,teardown_minutes:profile.afterMinutes,
    occupied_from: new Date(new Date(slot.startsAt).getTime() - (profile.beforeMinutes+input.outboundMinutes) * 60000), occupied_until: new Date(new Date(slot.endsAt).getTime() + (profile.afterMinutes+input.returnMinutes) * 60000), timezone: slot.timezone, version: { increment: 1 } } })
  await assignments(tx, scope, session.id, slot, true)
  const rows = await tx.appointmentBooking.findMany({ where: { company_id: scope.companyId, session_id: session.id } })
  for (const row of rows) {
    await tx.appointmentBooking.update({ where: { id: row.id }, data: { version: { increment: 1 } } })
    await history(tx, scope, row, 'RESCHEDULED', { startsAt: session.starts_at.toISOString() }, { startsAt: slot.startsAt }, input.reason)
  }
  await history(tx, scope, session, 'RESCHEDULED', { startsAt: session.starts_at.toISOString() }, { startsAt: slot.startsAt }, input.reason)
}
function checkVersion(row, expectedVersion) { if (row.version !== expectedVersion) fail(409, 'STALE_VERSION', 'Otra persona cambió este registro; vuelve a cargarlo') }
async function rescheduleBooking(db, scope, id, raw) {
  uuid(id, 'bookingId'); const input = { id, ...parseMove(raw) }
  return command(db, scope, 'appointments.edit', 'MOVE_BOOKING', input, async (tx, now) => {
    const row = await loadBooking(tx, scope, id); checkVersion(row, input.expectedVersion)
    if (row.session.mode !== 'INDIVIDUAL' || !['HELD', 'PENDING', 'CONFIRMED'].includes(row.status) || !occupiesSeat(row, now)) fail(409, 'INVALID_TRANSITION', 'Esta reserva no puede reprogramarse individualmente')
    await move(tx, scope, row.session, input, now)
    if (row.status === 'PENDING') await tx.appointmentBooking.update({ where: { id }, data: { expires_at: new Date(Math.min(now.getTime() + 86400000, new Date(input.startsAt).getTime())) } })
    return { type: 'BOOKING', id }
  })
}
async function rescheduleSession(db, scope, id, raw) {
  uuid(id, 'sessionId'); const input = { id, ...parseMove(raw) }
  return command(db, scope, 'appointments.edit', 'MOVE_SESSION', input, async (tx, now) => {
    const row = await loadSession(tx, scope, id); checkVersion(row, input.expectedVersion)
    if (row.mode !== 'GROUP') fail(400, 'NOT_GROUP', 'Reprograma la reserva individual, no la sesión')
    await move(tx, scope, row, input, now)
    await tx.appointmentBooking.updateMany({ where: { session_id: id, status: 'PENDING' }, data: { expires_at: new Date(Math.min(now.getTime() + 86400000, new Date(input.startsAt).getTime())) } })
    return { type: 'SESSION', id }
  })
}
async function transitionBooking(db, scope, id, raw) {
  uuid(id, 'bookingId'); const input = { id, ...parseTransition(raw) }
  const permission = input.action === 'CANCEL' ? 'appointments.cancel' : input.action === 'CONFIRM' ? 'appointments.edit' : 'appointments.attend'
  return command(db, scope, permission, 'TRANSITION_BOOKING', input, async (tx, now) => {
    const row = await loadBooking(tx, scope, id); checkVersion(row, input.expectedVersion)
    if (['HELD', 'PENDING'].includes(row.status) && !occupiesSeat(row, now)) {
      await expire(tx, scope, row.session_id, now)
      return { type: 'BOOKING', id }
    }
    const status = nextBookingState(row.status, input.action)
    if (input.action === 'CONFIRM') {
      const [checked] = await require('./queries').addConflicts(tx, scope, [row.session])
      if (checked.conflicts.length) fail(409, 'SCHEDULE_CONFLICT', 'Revisa el horario y las asignaciones antes de confirmar: ' + checked.conflicts.join(' · '))
    }
    if (['START', 'NO_SHOW'].includes(input.action) && row.session.starts_at > now) fail(409, 'TOO_EARLY', 'Esta acción está disponible a partir del inicio de la sesión')
    const resolveGroupAttendance = row.session.mode === 'GROUP' && row.session.status === 'COMPLETED' && ['ARRIVE', 'START', 'COMPLETE', 'NO_SHOW'].includes(input.action)
    if (['CANCELLED', 'COMPLETED'].includes(row.session.status) && input.action !== 'CANCEL' && !resolveGroupAttendance) fail(409, 'SESSION_CLOSED', 'La sesión ya está cerrada')
    await tx.appointmentBooking.update({ where: { id }, data: { status, expires_at: null, version: { increment: 1 } } })
    await history(tx, scope, row, input.action, { status: row.status }, { status }, input.reason)
    if(input.action==='CONFIRM')await require('./commercialDrafts').ensureBookingCommercialDraft(tx,scope,{booking:{...row,status}})
    if(['CANCEL','NO_SHOW','COMPLETE'].includes(input.action))await require('./engagementResolution').recordEngagementImpact(tx,scope,{bookingId:id,action:input.action,version:row.version,reason:input.reason})
    if (row.session.mode === 'INDIVIDUAL') {
      const sessionStatus = input.action === 'START' ? 'IN_PROGRESS' : ['COMPLETE', 'NO_SHOW'].includes(input.action) ? 'COMPLETED' : input.action === 'CANCEL' ? 'CANCELLED' : null
      if (sessionStatus) {
        await tx.appointmentSession.update({ where: { id: row.session_id }, data: { status: sessionStatus, version: { increment: 1 } } })
        await history(tx, scope, row.session, input.action, { status: row.session.status }, { status: sessionStatus }, input.reason)
      }
    }
    return { type: 'BOOKING', id }
  })
}
async function transitionSession(db, scope, id, raw) {
  uuid(id, 'sessionId'); const input = { id, ...parseTransition(raw, true) }
  return command(db, scope, input.action === 'CANCEL' ? 'appointments.cancel' : 'appointments.attend', 'TRANSITION_SESSION', input, async (tx, now) => {
    const row = await loadSession(tx, scope, id); checkVersion(row, input.expectedVersion)
    if (row.mode !== 'GROUP') fail(400, 'NOT_GROUP', 'Usa las acciones de la reserva individual')
    const status = nextSessionState(row.status, input.action)
    if (input.action === 'START' && row.starts_at > now) fail(409, 'TOO_EARLY', 'La sesión todavía no ha comenzado')
    if (input.action === 'CANCEL') {
      const bookings = await tx.appointmentBooking.findMany({ where: { company_id: scope.companyId, session_id: id, status: { in: ['HELD', 'PENDING', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'] } } })
      for (const b of bookings) {
        const next = occupiesSeat(b, now) ? 'CANCELLED' : 'EXPIRED'
        await tx.appointmentBooking.update({ where: { id: b.id }, data: { status: next, expires_at: null, version: { increment: 1 } } })
        await history(tx, scope, b, next, { status: b.status }, { status: next }, input.reason)
      }
    }
    await tx.appointmentSession.update({ where: { id }, data: { status, version: { increment: 1 },
      ...(input.action==='COMPLETE'?{actual_completed_at:now,commercial_completion_confirmed_at:now}:{}) } })
    await history(tx, scope, row, input.action, { status: row.status }, { status }, input.reason)
    if(['CANCEL','COMPLETE'].includes(input.action))await require('./engagementResolution').recordEngagementImpact(tx,scope,{sessionId:id,action:input.action,version:row.version,reason:input.reason})
    return { type: 'SESSION', id }
  })
}
async function loadWait(tx, scope, id) {
  const row = await tx.appointmentWaitlist.findFirst({ where: { id, company_id: scope.companyId, session: appointmentWhere(scope) } })
  if (!row) fail(404, 'NOT_FOUND', 'Registro de espera no encontrado')
  if (row.status !== 'WAITING') fail(409, 'WAITLIST_CLOSED', 'Este registro ya no está en espera')
  return row
}
async function joinWaitlist(db, scope, sessionId, raw) {
  uuid(sessionId, 'sessionId'); const v = object(raw, ['contactId', 'idempotencyKey'])
  const input = { sessionId, contactId: uuid(v.contactId, 'contactId'), idempotencyKey: requestKey(v.idempotencyKey) }
  return command(db, scope, 'appointments.create', 'JOIN_WAITLIST', input, async (tx, now) => {
    const s = await loadSession(tx, scope, sessionId)
    if (s.mode !== 'GROUP' || s.status !== 'SCHEDULED' || s.starts_at <= now) fail(409, 'SESSION_UNAVAILABLE', 'La sesión ya no admite espera')
    await contact(tx, scope, input.contactId)
    const old = await tx.appointmentWaitlist.findFirst({ where: { company_id: scope.companyId, session_id: sessionId, contact_id: input.contactId, status: 'WAITING' } })
    const bookings = await tx.appointmentBooking.findMany({ where: { company_id: scope.companyId, session_id: sessionId, contact_id: input.contactId } })
    if (old || bookings.some(b => occupiesSeat(b, now))) fail(409, 'DUPLICATE_WAITLIST', 'El cliente ya está inscrito o en espera')
    const row = await tx.appointmentWaitlist.create({ data: { company_id: scope.companyId, session_id: sessionId, contact_id: input.contactId, created_by: scope.userId } })
    await history(tx, scope, s, 'WAITLIST_JOINED', null, { waitlistId: row.id })
    return { type: 'WAITLIST', id: row.id }
  })
}
async function admitWaitlist(db, scope, id, raw) {
  uuid(id, 'waitlistId'); const v = object(raw, ['quantity', 'idempotencyKey'])
  const input = { id, quantity: quantity(v.quantity), idempotencyKey: requestKey(v.idempotencyKey) }
  return command(db, scope, 'appointments.create', 'ADMIT_WAITLIST', input, async (tx, now) => {
    const row = await loadWait(tx, scope, id)
    const first = await tx.appointmentWaitlist.findFirst({ where: { company_id: scope.companyId, session_id: row.session_id, status: 'WAITING' }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] })
    if (first?.id !== id) fail(409, 'WAITLIST_ORDER', 'Admite primero a la persona que encabeza la lista')
    const booking = await enroll(tx, scope, row.session_id, { contactId: row.contact_id, quantity: input.quantity, notes: '' }, now)
    await tx.appointmentWaitlist.update({ where: { id }, data: { status: 'ADMITTED', booking_id: booking.id } })
    await history(tx, scope, await loadSession(tx, scope, row.session_id), 'WAITLIST_ADMITTED', null, { waitlistId: id, bookingId: booking.id })
    return booking
  })
}
async function withdrawWaitlist(db, scope, id, raw) {
  uuid(id, 'waitlistId'); const v = object(raw, ['reason', 'idempotencyKey'])
  const input = { id, reason: text(v.reason, 'reason', 500), idempotencyKey: requestKey(v.idempotencyKey) }
  return command(db, scope, 'appointments.create', 'WITHDRAW_WAITLIST', input, async tx => {
    const row = await loadWait(tx, scope, id)
    await tx.appointmentWaitlist.update({ where: { id }, data: { status: 'WITHDRAWN' } })
    await history(tx, scope, await loadSession(tx, scope, row.session_id), 'WAITLIST_WITHDRAWN', null, { waitlistId: id }, input.reason)
    return { type: 'WAITLIST', id }
  })
}
module.exports = { withAgendaTransaction, withEmployeeAgendaLock, command, requireAction, loadBooking, loadSession, history, checkVersion, contact, expire, assignments,
  createBookingInTransaction,createSessionInTransaction,
  commercialSnapshot, insertBooking, createBooking, createSession, enrollBooking, rescheduleBooking, rescheduleSession,
  transitionBooking, transitionSession, joinWaitlist, admitWaitlist, withdrawWaitlist }
