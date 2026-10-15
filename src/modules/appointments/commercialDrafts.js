const {createHash}=require('node:crypto')
const {resolveEffectiveModules}=require('../platform/registry')
const {Prisma}=require('@prisma/client')
function draftDispositionForImpact(engagement){
  if(engagement.sale_id)return 'NONE'
  const cancelled=engagement.lines.flatMap(l=>l.schedules.filter(s=>s.state==='CANCELLED'))
  if(!cancelled.length)return 'NONE'
  if(engagement.lines.length===1&&engagement.lines[0].item_kind==='SERVICE'&&cancelled.reduce((sum,s)=>sum.add(s.quantity),new Prisma.Decimal(0)).gte(engagement.lines[0].qty))return 'CANCEL'
  return 'REVIEW'
}
async function syncDraftAfterImpact(tx,scope,id,requestKey,reason){
  const e=await tx.appointmentEngagement.findFirst({where:{id,company_id:scope.companyId},include:{lines:{include:{schedules:true}},origin_sale:{include:{status:true}}}})
  if(!e||draftDispositionForImpact(e)!=='CANCEL'||e.origin_sale?.status.name!=='Borrador')return
  const status=await tx.saleStatus.findUnique({where:{name:'Cancelada'}})
  if(!status)require('./domain/validation').fail(409,'SALE_CONFIGURATION_REQUIRED','Configura el estado de cancelación de venta')
  await tx.sale.update({where:{id:e.origin_sale.id},data:{status_id:status.id,version:{increment:1}}})
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:e.branch_id,sale_id:e.origin_sale.id,actor_id:scope.userId,action:'DRAFT_CANCELLED',request_key:requestKey,input_hash:requestKey,
    reason,before:{state:'DRAFT'},after:{state:'CANCELLED',engagementId:id}}})
}
async function reopenResolvedDraft(tx,scope,e,input){
  const draft=await tx.sale.findFirst({where:{branch_id:e.branch_id,origin_engagement_id:e.id,status:{name:'Cancelada'}}})
  if(!draft)return
  const status=await tx.saleStatus.findUnique({where:{name:'Borrador'}})
  await tx.sale.update({where:{id:draft.id},data:{status_id:status.id,version:{increment:1}}})
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:e.branch_id,sale_id:draft.id,actor_id:scope.userId,action:'DRAFT_REOPENED',request_key:input.idempotencyKey,
    input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),reason:input.reason,before:{state:'CANCELLED'},after:{state:'DRAFT',engagementId:e.id}}})
}
function presentCommercialPreparation(result,canViewSales){
  return {commercialPreparation:result.state,...(result.reason?{commercialPreparationReason:result.reason}:{}),
    ...(canViewSales&&result.state==='READY'?{commercialDocumentId:result.saleId}:{})}
}
async function integrationEnabled(tx,scope){
  const modules=resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!['appointments','inventory','contacts','sales','receivables'].every(code=>modules.some(m=>m.code===code&&m.effectiveEnabled)))return false
  const setting=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'inventory_services_enabled'}}})
  return String(setting?.value??'false').toLowerCase()==='true'
}
async function ensureScheduledEngagementDraft(tx,scope,engagementId){
  if(!await integrationEnabled(tx,scope))return {state:'PENDING',reason:'INTEGRATION_DISABLED'}
  return prepareValidatedEngagementDraft(tx,scope,engagementId)
}
async function prepareValidatedEngagementDraft(tx,scope,engagementId){
  const source=await tx.appointmentEngagement.findFirst({where:{id:engagementId,company_id:scope.companyId,branch_id:scope.branchId},include:{customer:{select:{id:true,name:true}},lines:{orderBy:{sort_order:'asc'}}}})
  if(!source)require('./domain/validation').fail(404,'NOT_FOUND','Contratación no encontrada')
  const result=await require('../sales').ensureEngagementDraft(tx,scope,{source})
  return {state:'READY',saleId:result.saleId}
}
async function ensureBookingCommercialDraft(tx,scope,{booking}){
  if(booking.status!=='CONFIRMED')return {state:'NOT_APPLICABLE'}
  let result
  if(!await integrationEnabled(tx,scope))result={state:'PENDING',reason:'INTEGRATION_DISABLED'}
  else{
    const existingId=booking.engagement_schedules[0]?.engagement_id||booking.commercial_snapshot.engagementId||booking.session.engagement_schedules.find(s=>s.kind==='SESSION')?.engagement_id
    if(existingId)return prepareValidatedEngagementDraft(tx,scope,existingId)
    const source=await require('./billingSourceData').bookingCommercialSource(tx,scope,booking)
    if(!source)result={state:'PENDING',reason:'COMMERCIAL_DATA_REQUIRED'}
    else{
      const key=`booking:${booking.id}`,hash=createHash('sha256').update(key).digest('hex')
      const row=await require('./engagementRecords').createEngagementRecord(tx,scope,{source,requestKey:key,inputHash:hash,origin:{kind:'BOOKING',id:booking.id,automation:true}})
      await tx.appointmentEngagementSchedule.create({data:{company_id:scope.companyId,branch_id:scope.branchId,engagement_id:row.id,line_id:row.lines[0].id,
        session_id:booking.session_id,session_type:'SCHEDULED_SERVICE',booking_id:booking.id,kind:'BOOKING',quantity:row.lines[0].qty,state:'COMMITTED',conditions_hash:hash}})
      return prepareValidatedEngagementDraft(tx,scope,row.id)
    }
  }
  await tx.appointmentBooking.update({where:{id:booking.id},data:{commercial_snapshot:{...booking.commercial_snapshot,preparationReason:result.reason}}})
  return result
}
module.exports={presentCommercialPreparation,integrationEnabled,ensureBookingCommercialDraft,ensureScheduledEngagementDraft,draftDispositionForImpact,syncDraftAfterImpact,reopenResolvedDraft}
