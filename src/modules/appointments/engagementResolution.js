const {createHash}=require('node:crypto')
const v=require('./domain/validation')
const {command}=require('./application')
const {assertCommercialAccess}=require('./access')
const {loadEngagement}=require('./commercialQueries')
const {loadLockedEngagement}=require('./engagements')
const {money,lockCustomer,resolveReservedFunds}=require('../receivables')
function parseResolution(raw){
  const p=v.object(raw,['action','amount','receiptId','refundId','replacementEngagementId','reason','expectedVersion','idempotencyKey','paymentMethodId','cashRegisterSessionId','reference'])
  if(!['KEEP','RELEASE','REQUEST_REFUND','CONFIRM_REFUND','CANCEL_REFUND','LINK_CORRECTION'].includes(p.action))v.invalid('action','Selecciona una resolución válida')
  const input={action:p.action,reason:v.text(p.reason,'reason',500),expectedVersion:v.version(p.expectedVersion),idempotencyKey:v.requestKey(v.text(p.idempotencyKey,'idempotencyKey',64))}
  if(p.action==='KEEP')return input
  if(p.action==='LINK_CORRECTION')return {...input,replacementEngagementId:v.uuid(p.replacementEngagementId,'replacementEngagementId')}
  input.receiptId=v.uuid(p.receiptId,'receiptId')
  input.amount=money(p.amount).toFixed(2)
  if(money(input.amount).lte(0))v.invalid('amount','Indica un importe mayor que cero')
  if(['CONFIRM_REFUND','CANCEL_REFUND'].includes(p.action))input.refundId=v.uuid(p.refundId,'refundId')
  if(p.action==='CONFIRM_REFUND'){
    input.paymentMethodId=v.integer(p.paymentMethodId,'paymentMethodId',1,2147483647)
    input.cashRegisterSessionId=p.cashRegisterSessionId?v.uuid(p.cashRegisterSessionId,'cashRegisterSessionId'):null
    input.reference=v.text(p.reference,'reference',255,false)
  }
  return input
}
async function resolveEngagementFunds(db,scope,id,raw){
  v.uuid(id,'engagementId');const input={id,...parseResolution(raw)}
  await assertCommercialAccess(db,scope,'refund')
  return command(db,scope,'appointments.refund','RESOLVE_ENGAGEMENT',input,async tx=>{
    await assertCommercialAccess(tx,scope,'refund')
    const initial=await loadEngagement(tx,scope,id)
    let correction
    if(input.action==='LINK_CORRECTION'){
      correction=await loadEngagement(tx,scope,input.replacementEngagementId)
      if(correction.id===id||correction.customer_id!==initial.customer_id||correction.branch_id!==initial.branch_id||!correction.quote_id||correction.quote_id===initial.quote_id||correction.sale_id||correction.commercial_snapshot.replacementEngagementId||correction.commercial_snapshot.supersedesEngagementId)v.fail(409,'INVALID_CORRECTION','Selecciona otra contratación de la misma sucursal y cliente, originada en una nueva cotización aceptada')
      const quote=await require('../quotes').loadQuoteSource(tx,scope,correction.quote_id)
      if(quote.customerId!==initial.customer_id)v.fail(409,'INVALID_CORRECTION','La cotización de corrección cambió de cliente')
      if(initial.order_id){const order=await require('../orders').lockEngagementOrder(tx,scope,initial.order_id);if(!['CANCELLED','DRAFT'].includes(order.status)||await tx.orderDelivery.count({where:{document_id:order.id,reversed_at:null}}))v.fail(409,'SOURCE_REVIEW_REQUIRED','Resuelve primero las entregas y reservas del pedido anterior')}
    }
    await lockCustomer(tx,initial.customer_id)
    const e=await loadLockedEngagement(tx,scope,id,input.expectedVersion,'appointments.refund')
    if(e.sale_id)v.fail(409,'USE_SALE_RETURN','La contratación ya tiene venta. Usa Devoluciones para corregirla y resolver el dinero aplicado')
    if(['KEEP','LINK_CORRECTION'].includes(input.action)&&e.commercial_snapshot.replacementEngagementId)v.fail(409,'SCOPE_SUPERSEDED','Continúa desde la contratación que corrige este alcance')
    if(input.action==='LINK_CORRECTION'){
      if(e.lines.some(l=>l.schedules.some(s=>s.state!=='RELEASED'&&!['CANCELLED','COMPLETED'].includes(s.session.status)&&!['CANCELLED','EXPIRED','NO_SHOW','COMPLETED'].includes(s.booking?.status))))v.fail(409,'ACTIVE_SCHEDULES','Cancela o resuelve la programación vigente antes de sustituir el alcance')
      correction=await loadEngagement(tx,scope,correction.id)
      if(correction.sale_id)v.fail(409,'INVALID_CORRECTION','La contratación nueva ya tiene venta')
      await tx.appointmentEngagement.update({where:{id},data:{commercial_snapshot:{...e.commercial_snapshot,replacementEngagementId:correction.id},resolution_pending:true}})
      await tx.appointmentEngagement.update({where:{id:correction.id},data:{commercial_snapshot:{...correction.commercial_snapshot,supersedesEngagementId:id},version:{increment:1}}})
      const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex')
      await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:e.customer_id,engagement_id:correction.id,actor_id:scope.userId,action:'SCOPE_CORRECTED',reason:input.reason,request_key:input.idempotencyKey,input_hash:hash,before:{engagementId:id},after:{quoteId:correction.quote_id}}})
    }else if(input.action==='KEEP'){
      if(e.order_id&&await tx.commercialDocumentSale.count({where:{document_id:e.order_id}}))v.fail(409,'SOURCE_REVIEW_REQUIRED','El pedido ya tiene ventas; revisa su facturación')
      const cancelled=e.lines.flatMap(l=>l.schedules.filter(s=>s.state==='CANCELLED'||s.state==='COMMITTED'&&s.booking&&require('./presentation').effectiveStatus(s.booking)==='EXPIRED'))
      if(!cancelled.length)v.fail(409,'NO_CANCELLED_SCHEDULE','No hay una programación cancelada que devolver a pendiente')
      await tx.appointmentEngagementSchedule.updateMany({where:{company_id:scope.companyId,id:{in:cancelled.map(s=>s.id)},state:{in:['CANCELLED','COMMITTED']}},data:{state:'RELEASED'}})
      await tx.appointmentEngagement.update({where:{id},data:{resolution_pending:false}})
      await require('./commercialDrafts').reopenResolvedDraft(tx,scope,e,input)
    }else await resolveReservedFunds(tx,scope,e,input)
    await tx.appointmentEngagement.update({where:{id},data:{version:{increment:1}}})
    await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:e.customer_id,engagement_id:id,actor_id:scope.userId,action:input.action,reason:input.reason,request_key:input.idempotencyKey,input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),after:{receiptId:input.receiptId||null,amount:input.amount||null,refundId:input.refundId||null}}})
    return {type:'ENGAGEMENT',id}
  })
}
async function recordEngagementImpact(tx,scope,{sessionId,bookingId,action,version,reason=''}){
  const rows=await tx.appointmentEngagementSchedule.findMany({where:{company_id:scope.companyId,...(bookingId?{booking_id:bookingId}:{session_id:sessionId}),...(!bookingId&&action==='COMPLETE'?{booking_id:null}:{})},include:{line:{select:{engagement:{select:{id:true,customer_id:true,branch_id:true}}}}}})
  const cancelled=['CANCEL','CANCELLED','EXPIRED','NO_SHOW'].includes(action)
  for(const row of rows){
    if(row.state==='RELEASED')continue
    if(row.state==='COMMITTED'&&(cancelled||action==='COMPLETE'))await tx.appointmentEngagementSchedule.update({where:{id:row.id},data:{state:cancelled?'CANCELLED':'COMPLETED'}})
    const e=row.line.engagement,key=createHash('sha256').update(`${bookingId||sessionId}:${action}:${version}:${row.id}`).digest('hex')
    await tx.appointmentEngagement.update({where:{id:e.id},data:{...(cancelled?{resolution_pending:true}:{}),version:{increment:1}}})
    await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:e.branch_id,customer_id:e.customer_id,engagement_id:e.id,actor_id:scope.userId||null,action:'OPERATION_CHANGED',reason,request_key:key,input_hash:key,after:{scheduleId:row.id,action}}})
    if(cancelled)await require('./commercialDrafts').syncDraftAfterImpact(tx,scope,e.id,key,reason)
  }
}
module.exports={parseResolution,resolveEngagementFunds,recordEngagementImpact}
