const {createHash}=require('node:crypto')
const v=require('./domain/validation')
const {money,lockCustomer,receiveEngagementPayment}=require('../receivables')
const {command}=require('./application')
const {assertCommercialAccess}=require('./access')
const {loadLockedEngagement}=require('./engagements')
const {getEngagement}=require('./commercialQueries')
function parsePayment(raw){
  const p=v.object(raw,['amount','paymentMethodId','paidAt','currencyCode','cashRegisterSessionId','reference','notes','expectedVersion','idempotencyKey'])
  const amount=money(p.amount)
  if(amount.lte(0))v.invalid('amount','Indica un pago mayor que cero')
  const paidAt=v.instant(p.paidAt??new Date().toISOString(),'paidAt')
  if(new Date(paidAt).getTime()>Date.now()+60000)v.invalid('paidAt','No puedes confirmar un pago con fecha futura')
  const currencyCode=v.text(p.currencyCode,'currencyCode',3)
  if(!/^[A-Z]{3}$/.test(currencyCode))v.invalid('currencyCode','Moneda inválida')
  return {amount:amount.toFixed(2),paidAt,currencyCode,paymentMethodId:v.integer(p.paymentMethodId,'paymentMethodId',1,2147483647),
    cashRegisterSessionId:p.cashRegisterSessionId?v.uuid(p.cashRegisterSessionId,'cashRegisterSessionId'):null,reference:v.text(p.reference,'reference',255,false),notes:v.text(p.notes,'notes',2000,false),
    expectedVersion:v.version(p.expectedVersion),idempotencyKey:v.requestKey(v.text(p.idempotencyKey,'idempotencyKey',64))}
}
async function collectEngagementPayment(db,scope,id,raw){
  v.uuid(id,'engagementId');const input={id,...parsePayment(raw)}
  await assertCommercialAccess(db,scope,'collect')
  return command(db,scope,'appointments.collect','COLLECT_ENGAGEMENT',input,async tx=>{
    await assertCommercialAccess(tx,scope,'collect')
    const initial=await require('./commercialQueries').loadEngagement(tx,scope,id)
    await require('./sourceVerification').lockEngagementQuote(tx,scope,initial)
    await lockCustomer(tx,initial.customer_id)
    const engagement=await loadLockedEngagement(tx,scope,id,input.expectedVersion,'appointments.collect')
    if(engagement.commercial_snapshot.replacementEngagementId)v.fail(409,'SCOPE_SUPERSEDED','Recibe pagos desde la contratación que corrige este alcance')
    if(engagement.resolution_pending||require('./commercialQueries').hasCancelledSchedules(engagement.lines))v.fail(409,'SOURCE_REVIEW_REQUIRED','Resuelve el alcance comercial antes de recibir pagos')
    const receipt=await receiveEngagementPayment(tx,scope,engagement,input)
    await tx.appointmentEngagement.update({where:{id},data:{version:{increment:1}}})
    await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:engagement.customer_id,engagement_id:id,actor_id:scope.userId,action:'PAYMENT_RECEIVED',
      request_key:input.idempotencyKey,input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),after:{receiptId:receipt.id}}})
    return {type:'PAYMENT',id:receipt.id}
  })
}
async function paymentResult(tx,scope,receiptId){
  await assertCommercialAccess(tx,scope,'collect')
  const event=await tx.paymentAllocationEvent.findFirst({where:{company_id:scope.companyId,payment_id:receiptId,action:'COMMITTED'},select:{engagement_id:true}})
  if(!event)v.fail(404,'NOT_FOUND','Recibo no encontrado')
  return {receiptId,engagement:await getEngagement(tx,scope,event.engagement_id)}
}
module.exports={collectEngagementPayment,paymentResult,parsePayment}
