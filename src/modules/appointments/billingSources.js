const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const v=require('./domain/validation')
const {command,requireAction,loadBooking,contact,checkVersion}=require('./application')
const {loadActivity}=require('./activities')
const {getEngagement}=require('./commercialQueries')
const {effectiveStatus}=require('./presentation')
const {assertCatalogIntegration,assertContactsIntegration}=require('./access')
const {resolveEffectiveModules}=require('../platform/registry')
const {commercialQuantity,lineSnapshot}=require('../../services/catalogItemRules')
const {money}=require('../receivables')
const {publicServiceConditions}=require('./index')
const {normalizeServicePolicy}=require('./domain/servicePolicy')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function parse(kind,id,raw,prepare=false){
  v.choice(kind,'kind',['bookings','activities']);v.uuid(id,'sourceId')
  const choices=kind==='activities'?['contactId','quantity']:[]
  const input=v.object(raw,[...choices,...(prepare?['expectedVersion','reviewHash','idempotencyKey']:[])])
  const out={kind,id,...(input.contactId!==undefined?{contactId:v.uuid(input.contactId,'contactId')}:{}),
    ...(kind==='activities'?{quantity:v.quantity(input.quantity??'1')}:{})}
  if(prepare){
    out.expectedVersion=v.version(input.expectedVersion);out.reviewHash=v.text(input.reviewHash,'reviewHash',64)
    if(!/^[a-f0-9]{64}$/.test(out.reviewHash))v.invalid('reviewHash','Revisa el resumen antes de continuar')
    out.idempotencyKey=v.requestKey(input.idempotencyKey)
  }
  return out
}
async function assertAccess(db,scope){
  for(const permission of ['appointments.view','appointments.create','receivables.view'])requireAction(scope,permission)
  await assertCatalogIntegration(db,scope);await assertContactsIntegration(db,scope)
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!['appointments','sales','receivables'].every(code=>modules.some(m=>m.code===code&&m.effectiveEnabled)))
    v.fail(403,'MODULE_DISABLED','Agenda, Cartera y Ventas deben estar habilitados para gestionar los cobros')
}
const {bookingLine}=require('./billingSourceData')
async function context(db,scope,input){
  const booking=input.kind==='bookings'?await loadBooking(db,scope,input.id):null
  const session=booking?.session||await loadActivity(db,scope,input.id),row=booking||session
  const origin={kind:booking?'BOOKING':'ACTIVITY',id:row.id,version:row.version}
  const schedule={startsAt:session.starts_at.toISOString(),endsAt:session.ends_at.toISOString(),timezone:session.timezone}
  const existingId=booking?(booking.engagement_schedules[0]?.engagement_id||booking.commercial_snapshot.engagementId||session.engagement_schedules.find(s=>s.kind==='SESSION')?.engagement_id):session.engagement_schedules[0]?.engagement_id
  if(existingId){
    const existing=await getEngagement(db,scope,existingId),l=existing.lines.find(l=>l.schedules.some(s=>s.bookingId===booking?.id||s.sessionId===session.id))||existing.lines[0]
    return {existing,booking,session,preview:{origin,engagementId:existing.id,customer:existing.customer,
      service:{id:l.productId,name:l.name,unitLabel:l.unitLabel,quantityDecimals:l.quantityDecimals},quantity:l.quantity,unitPrice:l.unitPrice,total:l.lineTotal,
      currencyCode:existing.money.currencyCode,priceSource:booking?'RESERVATION':'CURRENT_CATALOG',reviewHash:null,canPrepare:false,reason:'Este servicio ya tiene una contratación vinculada',schedule}}
  }
  if(session.status==='CANCELLED'||booking&&['CANCELLED','EXPIRED','NO_SHOW'].includes(effectiveStatus(booking)))v.fail(409,'SOURCE_UNAVAILABLE','La programación está cancelada, vencida o marcada como no presentada')
  if(!booking&&(!session.product_id||session.policy_snapshot.serviceScheduling!=='CONFIGURED'))v.fail(400,'NOT_BILLABLE_SERVICE','Esta actividad no es un servicio contratado. Usa Ventas para prestaciones sin Agenda')
  const product=await db.product.findFirst({where:{id:session.product_id,company_id:scope.companyId,kind:'SERVICE',deleted:false,available_for_sale:true}})
  if(!product)v.fail(400,'SERVICE_UNAVAILABLE','Selecciona un servicio activo de esta empresa')
  const customerId=booking?.contact_id||input.contactId
  let customer=null
  if(customerId){await contact(db,scope,customerId);customer=await db.supplier.findUnique({where:{id:customerId},select:{id:true,name:true}})}
  let line,currencyCode
  if(booking){line=bookingLine(booking,product);currencyCode=booking.commercial_snapshot.currencyCode}
  else{
    const snap=lineSnapshot(product),qty=commercialQuantity(input.quantity,product),price=money(product.price)
    line={productId:product.id,itemName:snap.item_name,itemKind:'SERVICE',unitLabel:snap.unit_label,quantityDecimals:snap.quantity_decimals,
      quantity:qty.toFixed(4),unitPrice:price.toFixed(2),lineTotal:price.mul(qty).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toFixed(2),sortOrder:0,
      serviceConditions:publicServiceConditions({...normalizeServicePolicy(session.policy_snapshot),allowedVenueKinds:session.policy_snapshot.allowedVenueKinds||['BRANCH']})}
    const setting=await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}});currencyCode=setting?.value||'GTQ'
  }
  money(line.lineTotal)
  const source={customerId,currencyCode,total:line.lineTotal,lines:[line],orders:[]}
  const reviewHash=customer?hash({origin,customerId,productId:line.productId,name:line.itemName,unitLabel:line.unitLabel,quantityDecimals:line.quantityDecimals,
    quantity:line.quantity,unitPrice:line.unitPrice,lineTotal:line.lineTotal,currencyCode,conditions:line.serviceConditions,sellable:true}):null
  return {source,booking,session,preview:{origin,engagementId:null,customer,service:{id:line.productId,name:line.itemName,unitLabel:line.unitLabel,quantityDecimals:line.quantityDecimals},
    quantity:line.quantity,unitPrice:line.unitPrice,total:line.lineTotal,currencyCode,priceSource:booking?'RESERVATION':'CURRENT_CATALOG',reviewHash,canPrepare:!!customer,reason:customer?'':'Selecciona el cliente al que se cobrará este servicio',schedule}}
}
async function previewBillingSource(db,scope,kind,id,raw={}){
  const input=parse(kind,id,raw);await assertAccess(db,scope)
  return (await context(db,scope,input)).preview
}
async function prepareBillingSource(db,scope,kind,id,raw){
  const input=parse(kind,id,raw,true);await assertAccess(db,scope)
  return command(db,scope,'appointments.create','PREPARE_SOURCE_BILLING',input,async tx=>{
    await assertAccess(tx,scope)
    const c=await context(tx,scope,input)
    if(c.existing){await require('./commercialDrafts').ensureScheduledEngagementDraft(tx,scope,c.existing.id);return {type:'ENGAGEMENT',id:c.existing.id}}
    checkVersion(c.booking||c.session,input.expectedVersion)
    if(!c.preview.canPrepare)v.invalid('contactId',c.preview.reason)
    if(c.preview.reviewHash!==input.reviewHash)v.fail(409,'BILLING_CONTEXT_CHANGED','El contexto comercial cambió. Actualiza y revisa el resumen antes de continuar')
    const origin={kind:c.preview.origin.kind,id},row=await require('./engagementRecords').createEngagementRecord(tx,scope,{source:c.source,requestKey:input.idempotencyKey,inputHash:hash(input),origin})
    const line=row.lines[0]
    await tx.appointmentEngagementSchedule.create({data:{company_id:scope.companyId,branch_id:scope.branchId,engagement_id:row.id,line_id:line.id,
      session_id:c.session.id,session_type:c.session.record_type,booking_id:c.booking?.id||null,kind:origin.kind,quantity:line.qty,
      state:(c.booking?c.booking.status==='COMPLETED':!!c.session.commercial_completion_confirmed_at)?'COMPLETED':'COMMITTED',conditions_hash:c.preview.reviewHash}})
    await require('./commercialDrafts').ensureScheduledEngagementDraft(tx,scope,row.id)
    return {type:'ENGAGEMENT',id:row.id}
  })
}
module.exports={previewBillingSource,prepareBillingSource}
