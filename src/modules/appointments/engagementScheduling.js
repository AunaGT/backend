const {Prisma}=require('@prisma/client')
const {createHash}=require('node:crypto')
const v=require('./domain/validation')
const {parseActivity,parseVenue}=require('./domain/activities')
const {assertLineCoverage,quantity}=require('./domain/engagement')
const {command,createBookingInTransaction,createSessionInTransaction}=require('./application')
const {createActivityInTransaction}=require('./activities')
const {loadLockedEngagement}=require('./engagements')
const {conditionInfo}=require('./commercialQueries')
function parsePrograms(raw){
  const input=v.object(raw,['programs','partial','expectedVersion','idempotencyKey'])
  if(!Array.isArray(input.programs)||!input.programs.length||input.programs.length>100)v.invalid('programs','Selecciona entre 1 y 100 programaciones')
  return {expectedVersion:v.version(input.expectedVersion),idempotencyKey:v.requestKey(v.text(input.idempotencyKey,'idempotencyKey',64)),partial:v.boolean(input.partial??false,'partial'),programs:input.programs.map(raw=>{
    const p=v.object(raw,['lineId','quantity','startsAt','endsAt','timezone','providerIds','resourceIds','venue','outboundMinutes','returnMinutes','organizerId','userIds','guests','estimatedAttendance','capacity','title','notes','acknowledgedConditionsVersion'])
    return {lineId:v.uuid(p.lineId,'lineId'),quantity:v.quantity(p.quantity),startsAt:v.instant(p.startsAt,'startsAt'),...(p.endsAt?{endsAt:v.instant(p.endsAt,'endsAt')}:{}),timezone:v.zone(p.timezone),
      providerIds:v.ids(p.providerIds??[],'providerIds'),resourceIds:v.ids(p.resourceIds??[],'resourceIds'),venue:parseVenue(p.venue??{kind:'BRANCH'}),
      outboundMinutes:v.integer(p.outboundMinutes??0,'outboundMinutes',0,1440),returnMinutes:v.integer(p.returnMinutes??0,'returnMinutes',0,1440),
      ...(p.organizerId?{organizerId:v.uuid(p.organizerId,'organizerId')}:{}),userIds:v.ids(p.userIds??[],'userIds'),guests:p.guests??[],estimatedAttendance:p.estimatedAttendance??null,
      ...(p.capacity!==undefined?{capacity:v.integer(p.capacity,'capacity',1,10000)}:{}),title:v.text(p.title,'title',200,false),notes:v.text(p.notes,'notes',2000,false),
      acknowledgedConditionsVersion:v.text(p.acknowledgedConditionsVersion,'acknowledgedConditionsVersion',64)}
  })}
}
async function createEngagementSchedule(tx,scope,engagement,line,program,now){
  if(line.item_kind!=='SERVICE')v.fail(400,'NOT_SERVICE','Los bienes no se programan en el calendario')
  const schedules=await tx.appointmentEngagementSchedule.findMany({where:{line_id:line.id,company_id:scope.companyId}})
  assertLineCoverage({itemKind:line.item_kind,quantity:line.qty,quantityDecimals:line.quantity_decimals},[...schedules,{quantity:program.quantity,state:'COMMITTED'}])
  const product=await tx.product.findFirst({where:{company_id:scope.companyId,id:line.product_id},include:{service_schedule_profile:{include:{branches:true}}}})
  const profile=product?.service_schedule_profile,info=conditionInfo(profile,product,scope.branchId,line.service_schedule_snapshot)
  if(!info.schedulingReady)v.fail(409,'SERVICE_UNAVAILABLE','Configura el servicio en Agenda para esta sucursal antes de programarlo')
  if(program.acknowledgedConditionsVersion!==info.conditionsVersion)v.fail(409,'CONDITIONS_CHANGED','Las condiciones de programación cambiaron. Revisa la comparación antes de confirmar',{acknowledgedConditionsVersion:info.conditionsVersion})
  const base={...program,productId:line.product_id,idempotencyKey:'internal'}
  let result,kind
  if(profile.scheduling_style==='WORK'){
    const endsAt=program.endsAt||new Date(new Date(program.startsAt).getTime()+profile.duration_minutes*60000).toISOString()
    result=await createActivityInTransaction(tx,scope,parseActivity({purpose:program.venue.kind==='EVENT_VENUE'?'EVENT':'SERVICE_VISIT',title:program.title||line.item_name,
      productId:line.product_id,serviceScheduling:'CONFIGURED',startsAt:program.startsAt,endsAt,timezone:program.timezone,organizerId:program.organizerId||scope.userId,
      providerIds:program.providerIds,resourceIds:program.resourceIds,userIds:program.userIds,guests:program.guests,venue:program.venue,estimatedAttendance:program.estimatedAttendance,
      outboundMinutes:program.outboundMinutes,returnMinutes:program.returnMinutes,setupMinutes:profile.before_minutes,teardownMinutes:profile.after_minutes,notes:program.notes,idempotencyKey:'internal'}),now)
    kind='ACTIVITY'
  }else if(profile.scheduling_style==='CLASS'){
    result=await createSessionInTransaction(tx,scope,v.parseSession({productId:line.product_id,startsAt:program.startsAt,...(program.endsAt?{endsAt:program.endsAt}:{}),timezone:program.timezone,providerIds:program.providerIds,resourceIds:program.resourceIds,
      venue:program.venue,outboundMinutes:program.outboundMinutes,returnMinutes:program.returnMinutes,notes:program.notes,capacity:program.capacity??profile.capacity,idempotencyKey:'internal'}),now)
    kind='SESSION'
  }else{
    const qty=quantity(program.quantity,line.quantity_decimals)
    const commercial={name:line.item_name,unit:line.unit_label,quantityDecimals:line.quantity_decimals,quantity:qty.toString(),unitPrice:line.unit_price.toFixed(2),
      total:line.line_total.mul(qty).div(line.qty).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toFixed(2),currencyCode:engagement.currency_code,engagementId:engagement.id}
    result=await createBookingInTransaction(tx,scope,v.parseBooking({productId:line.product_id,contactId:engagement.customer_id,startsAt:base.startsAt,...(base.endsAt?{endsAt:base.endsAt}:{}),timezone:base.timezone,providerIds:base.providerIds,resourceIds:base.resourceIds,
      venue:base.venue,outboundMinutes:base.outboundMinutes,returnMinutes:base.returnMinutes,notes:base.notes,quantity:program.quantity,idempotencyKey:'internal'}),now,{commercialSnapshot:commercial})
    kind='BOOKING'
  }
  const booking=kind==='BOOKING'?await tx.appointmentBooking.findUnique({where:{id:result.id},select:{session_id:true}}):null
  return tx.appointmentEngagementSchedule.create({data:{company_id:scope.companyId,branch_id:scope.branchId,engagement_id:engagement.id,line_id:line.id,session_id:booking?.session_id||result.id,
    session_type:kind==='ACTIVITY'?'ACTIVITY':'SCHEDULED_SERVICE',booking_id:booking?result.id:null,kind,quantity:program.quantity,conditions_hash:info.conditionsVersion}})
}
async function programEngagement(db,scope,id,raw){
  v.uuid(id,'engagementId');const input={id,...parsePrograms(raw)}
  return command(db,scope,'appointments.edit','PROGRAM_ENGAGEMENT',input,async(tx,now)=>{
    const initial=await require('./commercialQueries').loadEngagement(tx,scope,id)
    await require('./sourceVerification').lockEngagementQuote(tx,scope,initial)
    const engagement=await loadLockedEngagement(tx,scope,id,input.expectedVersion)
    if(engagement.commercial_snapshot.replacementEngagementId)v.fail(409,'SCOPE_SUPERSEDED','Programa desde la contratación que corrige este alcance')
    if(engagement.resolution_pending)v.fail(409,'SOURCE_REVIEW_REQUIRED','Resuelve la revisión comercial antes de programar')
    for(const program of input.programs){
      const line=engagement.lines.find(l=>l.id===program.lineId)
      if(!line)v.fail(404,'NOT_FOUND','Partida no encontrada en esta contratación')
      try{await createEngagementSchedule(tx,scope,engagement,line,program,now)}catch(error){
        if(error.status)error.fields={...error.fields,[`line-${line.id}`]:`${line.item_name}: ${error.message}`}
        throw error
      }
    }
    if(!input.partial)for(const line of engagement.lines.filter(l=>l.item_kind==='SERVICE')){
      const schedules=await tx.appointmentEngagementSchedule.findMany({where:{company_id:scope.companyId,line_id:line.id}})
      if(new Prisma.Decimal(assertLineCoverage({itemKind:line.item_kind,quantity:line.qty,quantityDecimals:line.quantity_decimals},schedules)).gt(0))v.fail(400,'PARTIAL_CONFIRMATION_REQUIRED','Quedan servicios sin programar. Confirma explícitamente una programación parcial')
    }
    await tx.appointmentEngagement.update({where:{id},data:{version:{increment:1}}})
    await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:engagement.customer_id,engagement_id:id,actor_id:scope.userId,action:'PROGRAMMED',
      request_key:input.idempotencyKey,input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),after:{count:input.programs.length,partial:input.partial}}})
    await require('./commercialDrafts').ensureScheduledEngagementDraft(tx,scope,id)
    return {type:'ENGAGEMENT',id}
  })
}
module.exports={programEngagement,createEngagementSchedule,parsePrograms}
