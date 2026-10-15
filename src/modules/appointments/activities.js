const v=require('./domain/validation')
const {parseActivity,parseActivityUpdate,parseActivityTransition,activityInterval}=require('./domain/activities')
const {command,history,checkVersion,assignments}=require('./application')
const {appointmentWhere,agendaCapabilities,hasAgendaPermission,assertContactsIntegration,assertAppointmentsEnabled}=require('./access')
const {assertActivityAvailability}=require('./occupancy')
const {nextSessionState}=require('./domain/states')
const canReadNotes=scope=>['appointments.attend','appointments.configure'].some(p=>hasAgendaPermission(scope,p))
const include={engagement_schedules:{select:require('./presentation').engagementScheduleSelect},providers:{include:{provider:{select:{id:true,name:true}}}},resources:{include:{resource:{select:{id:true,name:true}}}},participants:{include:{user:{select:{id:true,name:true}}}},organizer:{select:{id:true,name:true,photo_url:true}},
  history:{orderBy:[{created_at:'desc'},{id:'desc'}],take:100,select:{id:true,action:true,actor_id:true,created_at:true,reason:true,before:true,after:true}}}
async function loadActivity(db,scope,id) {
  v.uuid(id,'activityId')
  const row=await db.appointmentSession.findFirst({where:{...appointmentWhere(scope),id,record_type:'ACTIVITY'},include})
  if(!row) v.fail(404,'NOT_FOUND','Actividad no encontrada')
  return row
}
function presentActivity(row,scope) {
  return {...require('./domain/servicePolicy').completionInfo(row),id:row.id,recordType:'ACTIVITY',branchId:row.branch_id,purpose:row.purpose,title:row.title,productId:row.product_id,
    ...(row.engagement_schedules?.[0]?{engagementId:row.engagement_schedules[0].engagement_id}:{}),
    ...require('./presentation').commercialPreparation(row.engagement_schedules,{eligible:!!row.product_id&&row.policy_snapshot?.serviceScheduling==='CONFIGURED'}),
    ...(row.policy_snapshot?.serviceScheduling==='CONFIGURED'?{serviceScheduling:'CONFIGURED',schedulingPolicy:require('./domain/servicePolicy').publicServicePolicy(row.policy_snapshot)}:{}),
    organizerId:row.organizer_id,organizer:row.organizer?{id:row.organizer.id,name:row.organizer.name,photoUrl:row.organizer.photo_url}:null,
    userIds:row.participants.filter(p=>p.kind==='USER').map(p=>p.user_id),
    participants:row.participants.filter(p=>p.kind==='USER').map(p=>({id:p.user_id,name:p.user?.name||'Persona asignada'})),
    providers:row.providers.map(p=>({id:p.provider_id,name:p.provider?.name||'Profesional asignado'})),
    resources:row.resources.map(r=>({id:r.resource_id,name:r.resource?.name||'Recurso asignado'})),
    guests:row.participants.filter(p=>p.kind==='GUEST').map(p=>({name:p.name,contactId:p.contact_id})),
    providerIds:row.providers.map(p=>p.provider_id),resourceIds:row.resources.map(r=>r.resource_id),
    startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),occupiedFrom:row.occupied_from.toISOString(),occupiedUntil:row.occupied_until.toISOString(),
    timezone:row.timezone,venue:row.venue,estimatedAttendance:row.estimated_attendance,
    outboundMinutes:row.outbound_minutes,setupMinutes:row.setup_minutes,teardownMinutes:row.teardown_minutes,returnMinutes:row.return_minutes,
    status:row.status,version:row.version,notes:canReadNotes(scope)?row.notes:null,
    history:row.history.map(h=>({id:h.id,action:h.action,actorId:h.actor_id,at:h.created_at.toISOString(),reason:h.reason,before:h.before,after:h.after}))}
}
async function getActivity(db,scope,id) { await assertAppointmentsEnabled(db,scope);return presentActivity(await loadActivity(db,scope,id),scope) }
async function validateReferences(tx,scope,input,old) {
  if(input.productId&&input.productId!==old?.product_id) await require('./profiles').serviceProduct(tx,scope,input.productId)
  const previous=new Set((old?.participants||[]).filter(p=>p.kind==='GUEST').map(p=>p.contact_id))
  const ids=input.guests.map(g=>g.contactId).filter(id=>id&&!previous.has(id))
  if(ids.length) {
    await assertContactsIntegration(tx,scope)
    const count=await tx.supplier.count({where:{company_id:scope.companyId,id:{in:ids},deleted:false,estado:1,party_type:'CUSTOMER'}})
    if(count!==ids.length) v.fail(400,'INVALID_CONTACT','Selecciona contactos activos de esta empresa')
  }
}
function data(input,scope,old) {
  const range=activityInterval(input)
  return {purpose:input.purpose,title:input.title,organizer_id:input.organizerId,product_id:input.productId,
    starts_at:new Date(range.startsAt),ends_at:new Date(range.endsAt),occupied_from:new Date(range.occupiedFrom),occupied_until:new Date(range.occupiedUntil),
    timezone:input.timezone,venue:input.venue,estimated_attendance:input.estimatedAttendance,
    outbound_minutes:input.outboundMinutes,setup_minutes:input.setupMinutes,teardown_minutes:input.teardownMinutes,return_minutes:input.returnMinutes,
    completion_policy:input.completionPolicy||'MANUAL',notes:old&&!canReadNotes(scope)?old.notes:input.notes}
}
async function participants(tx,scope,id,input,replace=false) {
  if(replace) await tx.appointmentParticipant.deleteMany({where:{company_id:scope.companyId,session_id:id}})
  const rows=[...input.userIds.map(user_id=>({kind:'USER',user_id})),...input.guests.map(g=>({kind:'GUEST',name:g.name,contact_id:g.contactId}))]
  if(rows.length) await tx.appointmentParticipant.createMany({data:rows.map(row=>({...row,company_id:scope.companyId,session_id:id}))})
  await assignments(tx,scope,id,input,replace)
}
// History contains operational changes, not notes, addresses or guest details.
function snapshot(input) { return {title:input.title,purpose:input.purpose,startsAt:input.startsAt,endsAt:input.endsAt,
  organizerId:input.organizerId,userIds:input.userIds,providerIds:input.providerIds,resourceIds:input.resourceIds,venueKind:input.venue.kind} }
async function createActivity(db,scope,raw) {
  const input=parseActivity(raw)
  return command(db,scope,'appointments.create','CREATE_ACTIVITY',input,(tx,now)=>createActivityInTransaction(tx,scope,input,now))
}
async function createActivityInTransaction(tx,scope,input,now){
    const prepared=await require('./configuredActivities').applyConfiguredActivityPolicy(tx,scope,input)
    await validateReferences(tx,scope,prepared.input)
    await assertActivityAvailability(tx,scope,prepared.input)
    const row=await tx.appointmentSession.create({data:{...data(prepared.input,scope),company_id:scope.companyId,branch_id:scope.branchId,
      record_type:'ACTIVITY',mode:'INDIVIDUAL',capacity:1,policy_snapshot:{...prepared.policySnapshot,completionPolicy:prepared.input.completionPolicy},created_by:scope.userId}})
    await participants(tx,scope,row.id,prepared.input)
    await history(tx,scope,row,'CREATED',null,snapshot(prepared.input))
    return {type:'ACTIVITY',id:row.id}
}
async function updateActivity(db,scope,id,raw) {
  v.uuid(id,'activityId');const input={id,...parseActivityUpdate(raw)}
  return command(db,scope,'appointments.edit','UPDATE_ACTIVITY',input,async tx=>{
    const old=await loadActivity(tx,scope,id);checkVersion(old,input.expectedVersion)
    if(old.status!=='SCHEDULED') v.fail(409,'ACTIVITY_CLOSED','Solo puedes editar actividades programadas')
    if(old.engagement_schedules.length&&input.productId!==old.product_id)v.fail(409,'SOURCE_COMMERCIAL_LOCKED','El servicio tiene una contratación vinculada; resuelve su alcance antes de cambiarlo')
    const prepared=await require('./configuredActivities').applyConfiguredActivityPolicy(tx,scope,input,old)
    await validateReferences(tx,scope,prepared.input,old)
    await assertActivityAvailability(tx,scope,prepared.input,{excludeSessionId:id})
    await tx.appointmentSession.update({where:{id},data:{...data(prepared.input,scope,old),policy_snapshot:{...prepared.policySnapshot,completionPolicy:prepared.input.completionPolicy},version:{increment:1}}})
    await participants(tx,scope,id,prepared.input,true)
    await history(tx,scope,old,'UPDATED',{title:old.title,startsAt:old.starts_at.toISOString(),endsAt:old.ends_at.toISOString()},snapshot(prepared.input),input.reason)
    return {type:'ACTIVITY',id}
  })
}
async function transitionActivity(db,scope,id,raw) {
  v.uuid(id,'activityId');const input={id,...parseActivityTransition(raw)}
  return command(db,scope,input.action==='CANCEL'?'appointments.cancel':'appointments.attend','TRANSITION_ACTIVITY',input,async(tx,now)=>{
    const row=await loadActivity(tx,scope,id);checkVersion(row,input.expectedVersion)
    if(input.action==='CONFIRM_COMPLETION'&&(row.status!=='COMPLETED'||!row.actual_completed_at||row.commercial_completion_confirmed_at))v.fail(409,'COMPLETION_NOT_PENDING','No hay una realización pendiente de confirmar')
    const status=input.action==='CONFIRM_COMPLETION'?row.status:nextSessionState(row.status,input.action)
    if(input.action==='START'&&row.starts_at>now) v.fail(409,'TOO_EARLY','La actividad todavía no ha comenzado')
    await tx.appointmentSession.update({where:{id},data:{status,version:{increment:1},...(input.action==='COMPLETE'?{actual_completed_at:now,commercial_completion_confirmed_at:now}:input.action==='CONFIRM_COMPLETION'?{commercial_completion_confirmed_at:now}:{})}})
    await history(tx,scope,row,input.action,{status:row.status},{status},input.reason)
    if(['CANCEL','COMPLETE','CONFIRM_COMPLETION'].includes(input.action))await require('./engagementResolution').recordEngagementImpact(tx,scope,{sessionId:id,action:input.action==='CONFIRM_COMPLETION'?'COMPLETE':input.action,version:row.version,reason:input.reason})
    return {type:'ACTIVITY',id}
  })
}
async function listActivityUsers(db,scope,raw={}) {
  await assertAppointmentsEnabled(db,scope)
  const q=v.text(raw.q,'q',150,false),page=v.integer(raw.page??1,'page',1,10000,true)
  const where={user_companies:{some:{company_id:scope.companyId,status:'ACTIVE'}},user_branches:{some:{branch_id:scope.branchId||{in:scope.branchIds}}},...(q?{name:{contains:q,mode:'insensitive'}}:{})}
  const [items,total]=await Promise.all([db.user.findMany({where,select:{id:true,name:true,photo_url:true},orderBy:[{name:'asc'},{id:'asc'}],skip:(page-1)*10,take:10}),db.user.count({where})])
  return {items:items.map(u=>({id:u.id,name:u.name,photoUrl:u.photo_url})),total,page,pageSize:10}
}
module.exports={createActivity,createActivityInTransaction,updateActivity,transitionActivity,getActivity,listActivityUsers,presentActivity,loadActivity}
