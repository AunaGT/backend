const { hasAgendaPermission } = require('./access')
const { occupiesSeat } = require('./domain/states')
const { assigned } = require('./domain/availability')
const iso = value => value ? new Date(value).toISOString() : null
const effectiveStatus = (row, now = new Date()) => ['HELD', 'PENDING'].includes(row.status) && !occupiesSeat(row, now) ? 'EXPIRED' : row.status
const location=row=>({...require('./domain/servicePolicy').completionInfo(row),schedulingPolicy:require('./domain/servicePolicy').publicServicePolicy(row.policy_snapshot||{}),venue:row.venue||{kind:'BRANCH'},outboundMinutes:row.outbound_minutes||0,returnMinutes:row.return_minutes||0,
  setupMinutes:row.setup_minutes||0,teardownMinutes:row.teardown_minutes||0,occupiedFrom:iso(row.occupied_from),occupiedUntil:iso(row.occupied_until)})
const engagementScheduleSelect={engagement_id:true,kind:true,line:{select:{engagement:{select:{origin_sale:{select:{id:true}}}}}}}
function commercialPreparation(links,{eligible=false,reason}={}){
  if(links?.some(link=>link.line?.engagement?.origin_sale))return {commercialPreparation:'READY'}
  return eligible||links?.length||reason?{commercialPreparation:'PENDING',commercialPreparationReason:reason||'COMMERCIAL_DATA_REQUIRED'}:{commercialPreparation:'NOT_APPLICABLE'}
}
function presentBooking(row, scope) {
  const s = row.session
  const engagementId=row.engagement_schedules?.[0]?.engagement_id||row.commercial_snapshot.engagementId||s.engagement_schedules?.find(link=>link.kind==='SESSION')?.engagement_id||null
  const includedInEngagement=row.commercial_snapshot.includedInEngagement===true
  return { ...location(s),id: row.id, sessionId: row.session_id, contactId: row.contact_id, contactName: row.contact?.name || '', contactImageUrl: row.contact?.image_url || null,
    productId: s.product_id, serviceName: row.commercial_snapshot.name, branchId: row.branch_id,
    startsAt: iso(s.starts_at), endsAt: iso(s.ends_at), timezone: s.timezone, providerIds: assigned(s, 'providers'), resourceIds: assigned(s, 'resources'),
    status: effectiveStatus(row), version: row.version, expiresAt: iso(row.expires_at),
    ...(engagementId?{engagementId,includedInEngagement}:{}),
    ...commercialPreparation([...(row.engagement_schedules||[]),...(s.engagement_schedules||[]).filter(link=>link.kind==='SESSION')],{eligible:row.status==='CONFIRMED',reason:row.commercial_snapshot.preparationReason}),
    commercial: !includedInEngagement&&hasAgendaPermission(scope,'receivables.view') ? row.commercial_snapshot : null,
    notes: ['appointments.attend', 'appointments.configure'].some(p => hasAgendaPermission(scope, p)) ? row.notes : null, conflicts: row.conflicts || [] }
}
function presentSession(row, scope) {
  return { ...location(row),id: row.id, productId: row.product_id, serviceName: row.product?.name || '', branchId: row.branch_id, mode: row.mode,
    ...(row.engagement_schedules?.find(link=>link.kind==='SESSION')?{engagementId:row.engagement_schedules.find(link=>link.kind==='SESSION').engagement_id}:{}),
    bookingId: row.mode === 'INDIVIDUAL' ? row.bookings?.find(b => occupiesSeat(b, new Date()))?.id || null : null,
    startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), timezone: row.timezone, providerIds: assigned(row, 'providers'), resourceIds: assigned(row, 'resources'),
    status: row.status, capacity: row.capacity, occupied: row.bookings?.filter(b => occupiesSeat(b, new Date())).length || 0, version: row.version, conflicts: row.conflicts || [] }
}
const sessionInclude = { providers: true, resources: true, engagement_schedules:{select:engagementScheduleSelect},product: { select: { name: true, deleted: true, available_for_sale: true, service_schedule_profile: { select: { enabled: true } } } }, bookings: { select: { id: true, session_id: true, status: true, expires_at: true } } }
const bookingInclude = { engagement_schedules:{select:engagementScheduleSelect},session: { include: sessionInclude }, contact: { select: { id: true, name: true, image_storage_path: true } } }
function authorizedIncludes(capabilities,scope) {
  const session={...sessionInclude,product:capabilities.catalog&&hasAgendaPermission(scope,'products.view') ? sessionInclude.product : false}
  const contact=capabilities.contacts&&hasAgendaPermission(scope,'contacts.clients.view') ? bookingInclude.contact : false
  return {session,booking:{engagement_schedules:bookingInclude.engagement_schedules,session:{include:session},contact},contact}
}
module.exports = { presentBooking, presentSession, effectiveStatus, sessionInclude, bookingInclude,authorizedIncludes,engagementScheduleSelect,commercialPreparation }
