const v=require('./domain/validation')
const {appointmentWhere,agendaCapabilities,hasAgendaPermission,assertAppointmentsEnabled}=require('./access')
const {PURPOSES,VENUE_KINDS}=require('./domain/activities')
const {occupiesSeat}=require('./domain/states')
function entryFilter(scope,raw,capabilities) {
  const {recordType,purpose,venueKind,status,...base}=v.object(raw,['from','to','q','providerId','resourceId','productId','status','page','pageSize','recordType','purpose','venueKind'])
  const filter=v.parseFilter(base)
  const where={...appointmentWhere(scope),occupied_from:{lt:new Date(filter.to)},occupied_until:{gt:new Date(filter.from)}}
  if(recordType) where.record_type=v.choice(recordType,'recordType',['ACTIVITY','SCHEDULED_SERVICE'])
  if(purpose) where.purpose=v.choice(purpose,'purpose',PURPOSES)
  if(venueKind) where.venue={path:['kind'],equals:v.choice(venueKind,'venueKind',VENUE_KINDS)}
  if(status) where.status=v.choice(status,'status',['SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED'])
  if(filter.productId) where.product_id=filter.productId
  if(filter.providerId) where.AND=[{providers:{some:{provider_id:filter.providerId}}}]
  if(filter.resourceId) where.resources={some:{resource_id:filter.resourceId}}
  if(filter.q) where.AND=[...(where.AND||[]),{OR:[{title:{contains:filter.q,mode:'insensitive'}},
    ...(capabilities.catalog&&hasAgendaPermission(scope,'products.view')?[{product:{name:{contains:filter.q,mode:'insensitive'}}}]:[]),
    ...(capabilities.contacts&&hasAgendaPermission(scope,'contacts.clients.view')?[{bookings:{some:{contact:{name:{contains:filter.q,mode:'insensitive'}}}}}]:[])]}]
  return {filter,where}
}
async function context(db,scope,raw) {
  await assertAppointmentsEnabled(db,scope)
  const capabilities=await agendaCapabilities(db,scope)
  return {...entryFilter(scope,raw,capabilities),capabilities}
}
function entrySelect(capabilities,scope) {
  return {id:true,company_id:true,branch_id:true,record_type:true,purpose:true,title:true,organizer_id:true,product_id:true,
    mode:true,status:true,version:true,capacity:true,starts_at:true,ends_at:true,occupied_from:true,occupied_until:true,timezone:true,completion_policy:true,actual_completed_at:true,commercial_completion_confirmed_at:true,
    venue:true,estimated_attendance:true,providers:true,resources:true,participants:{where:{kind:'USER'},select:{user_id:true}},
    organizer:{select:{name:true}},
    ...(capabilities.catalog&&hasAgendaPermission(scope,'products.view')?{product:{select:{name:true,deleted:true,available_for_sale:true,service_schedule_profile:{select:{enabled:true}}}}}:{}),
    bookings:{select:{id:true,session_id:true,status:true,expires_at:true,commercial_snapshot:true,
      ...(capabilities.contacts&&hasAgendaPermission(scope,'contacts.clients.view')?{contact:{select:{name:true}}}:{})}}}
}
function presentEntry(row) {
  const booked=row.bookings.find(b=>occupiesSeat(b,new Date()))
  return {...require('./domain/servicePolicy').completionInfo(row),id:row.id,recordType:row.record_type,purpose:row.purpose,title:row.title||row.product?.name||row.bookings[0]?.commercial_snapshot?.name||'Servicio programado',
    organizerName:row.organizer?.name||'',contactName:booked?.contact?.name||'',organizerId:row.organizer_id,branchId:row.branch_id,productId:row.product_id,
    // This projection intentionally excludes address, links, guests and financial details.
    venue:{kind:row.venue?.kind||'BRANCH'},estimatedAttendance:row.estimated_attendance,mode:row.mode,
    bookingId:row.mode==='INDIVIDUAL'?(booked||row.bookings[0])?.id||null:null,
    serviceName:row.title||row.product?.name||row.bookings[0]?.commercial_snapshot?.name||'Servicio programado',
    startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),occupiedFrom:row.occupied_from.toISOString(),occupiedUntil:row.occupied_until.toISOString(),timezone:row.timezone,
    providerIds:row.providers.map(p=>p.provider_id),resourceIds:row.resources.map(r=>r.resource_id),
    status:row.status,version:row.version,capacity:row.capacity,occupied:row.bookings.filter(b=>occupiesSeat(b,new Date())).length,conflicts:row.conflicts||[]}
}
async function listEntries(db,scope,raw) {
  const {filter,where,capabilities}=await context(db,scope,raw)
  const [totalItems,rows]=await Promise.all([db.appointmentSession.count({where}),db.appointmentSession.findMany({where,select:entrySelect(capabilities,scope),
    orderBy:[{starts_at:'asc'},{id:'asc'}],skip:(filter.page-1)*filter.pageSize,take:filter.pageSize})])
  const checked=await require('./queries').addConflicts(db,scope,rows)
  return {items:checked.map(presentEntry),totalItems,page:filter.page,pageSize:filter.pageSize}
}
async function readEntriesSummary(db,scope,raw) {
  const {where}=await context(db,scope,raw)
  const names={scheduled:'SCHEDULED',inProgress:'IN_PROGRESS',completed:'COMPLETED',cancelled:'CANCELLED'}
  const [activities,...counts]=await Promise.all([db.appointmentSession.count({where}),...Object.values(names).map(status=>db.appointmentSession.count({where:{AND:[where,{status}]}}))])
  return {activities,...Object.fromEntries(Object.keys(names).map((key,i)=>[key,counts[i]]))}
}
module.exports={listEntries,readEntriesSummary,entryFilter,presentEntry}
