const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {fail}=require('./domain/validation')
const {hasAgendaPermission}=require('./access')
const {engagementMoney,engagementCurrencyReason,lockCustomer}=require('../receivables')
const {assertLineCoverage}=require('./domain/engagement')
const {evaluateEventPaymentTerms,readEventPaymentTermsSnapshot}=require('../../services/eventPaymentTerms')
const {sessionInput,sessionBlocks,requirementEligibility,shareIdentity}=require('./domain/operationalTimeline')
const {assertAssignmentRequirements,providerIdentityMap}=require('./domain/assignmentRequirements')
const {overlaps}=require('./domain/availability')

function assertPolicyScope(scope,e){
  if(e.company_id!==scope.companyId||!(scope.branchId?e.branch_id===scope.branchId:scope.branchIds?.includes(e.branch_id))||!hasAgendaPermission(scope,'appointments.view'))
    fail(404,'NOT_FOUND','Contratación no encontrada')
}
function activeSchedules(e){return e.lines.filter(l=>l.item_kind==='SERVICE').flatMap(l=>l.schedules.filter(s=>s.state!=='RELEASED'))}
function cancelledSchedule(s,now){
  return s.state==='CANCELLED'||s.session.status==='CANCELLED'||s.booking&&['CANCELLED','EXPIRED','NO_SHOW'].includes(require('./presentation').effectiveStatus(s.booking,now))
}
async function inspectPaymentScheduling(db,scope,e,now){
  const services=e.lines.filter(l=>l.item_kind==='SERVICE'),schedules=activeSchedules(e)
  const complete=services.length>0&&services.every(l=>new Prisma.Decimal(assertLineCoverage({itemKind:l.item_kind,quantity:l.qty,quantityDecimals:l.quantity_decimals},l.schedules)).eq(0))
  if(schedules.some(s=>cancelledSchedule(s,now)))return {complete:false,valid:false,context:[]}
  const ids=[...new Set(schedules.filter(s=>!['COMPLETED','SOLD'].includes(s.state)&&s.session.status!=='COMPLETED').map(s=>s.session_id))].sort()
  if(!ids.length)return {complete,valid:true,context:schedules.map(s=>({id:s.id,state:s.state,startsAt:s.session.starts_at,endsAt:s.session.ends_at}))}
  const rows=await db.appointmentSession.findMany({where:{company_id:scope.companyId,branch_id:e.branch_id,id:{in:ids}},include:{providers:true,resources:{include:{resource:true}},participants:{where:{kind:'USER'}},product:{select:{deleted:true,available_for_sale:true,service_schedule_profile:{select:{enabled:true}}}}}})
  if(rows.length!==ids.length)return {complete,valid:false,context:[]}
  const {resolveBusyIdentities,loadBusyAssignments,validateActivityPeople}=require('./occupancy')
  const identities=await resolveBusyIdentities(db,scope,{providerIds:[...new Set(rows.flatMap(r=>r.providers.map(p=>p.provider_id)))],
    userIds:[...new Set(rows.flatMap(r=>[r.organizer_id,...r.participants.map(p=>p.user_id)]).filter(Boolean))]})
  const identityById=providerIdentityMap(identities.links)
  const busy=await loadBusyAssignments(db,scope,{from:new Date(Math.min(...rows.map(r=>r.occupied_from.getTime()))),to:new Date(Math.max(...rows.map(r=>r.occupied_until.getTime()))),identities,
    resourceIds:[...new Set(rows.flatMap(r=>r.resources.map(a=>a.resource_id)))],now})
  let valid=true
  for(const row of await require('./queries').addConflicts(db,scope,rows)){
    const input=sessionInput(row),blocks=sessionBlocks(row,identityById),policy=row.policy_snapshot||{}
    if(row.conflicts.length||policy.requiresProvider&&!input.providerIds.length||policy.requiresResource&&!input.resourceIds.length)valid=false
    if(busy.some(other=>other.sessionId!==row.id&&blocks.some(own=>shareIdentity(own,other)&&overlaps(own,other))))valid=false
    try{
      if(row.record_type==='ACTIVITY')await validateActivityPeople(db,{...scope,branchId:e.branch_id},input)
      require('./domain/activities').validateVenueAssignments(input.venue,row.resources.map(r=>r.resource),row.estimated_attendance??row.capacity)
      const requirements=[...(policy.assignmentRequirements||[])]
      for(const [kind,required,field]of [['PROVIDER',policy.requiresProvider,'providerIds'],['RESOURCE',policy.requiresResource,'resourceIds']])
        if(required&&!requirements.some(r=>r.kind===kind))requirements.push({id:`legacy-${kind}`,kind,name:'Asignación completa',quantity:1,optionIds:input[field]})
      assertAssignmentRequirements(requirements,{...input,identityById,eligibleByRequirement:requirementEligibility({requirements,timeline:input.operationalTimeline,session:input,identityById})})
    }catch(error){if(![400,409].includes(error.status))throw error;valid=false}
  }
  return {complete,valid,context:rows.map(r=>({id:r.id,version:r.version,status:r.status,startsAt:r.starts_at,endsAt:r.ends_at,policy:r.policy_snapshot,
    providers:r.providers.map(p=>p.provider_id).sort(),resources:r.resources.map(a=>a.resource_id).sort(),participants:r.participants.map(a=>a.user_id).sort(),timeline:r.operational_timeline})).sort((a,b)=>a.id.localeCompare(b.id))}
}
async function loadEngagementPaymentState(db,scope,engagement,{now=new Date(),lockMoney=false,money:knownMoney}={}){
  assertPolicyScope(scope,engagement)
  if(!engagement.event_payment_terms)return evaluateEventPaymentTerms({terms:null})
  let e=engagement
  if(lockMoney){
    await require('./sourceVerification').lockEngagementQuote(db,scope,e,{internal:true})
    await lockCustomer(db,e.customer_id)
    await db.$queryRaw`SELECT id FROM appointment_engagements WHERE id=${e.id}::uuid AND company_id=${scope.companyId}::uuid FOR UPDATE`
    e=await require('./commercialQueries').loadEngagement(db,scope,e.id)
  }
  let sourceChanged=false
  if(e.quote_id&&!lockMoney){
    const quote=await db.commercialDocument.findFirst({where:{id:e.quote_id,doc_type:'QUOTE',branch_id:e.branch_id,branch:{company_id:scope.companyId}},include:{lines:{orderBy:{sort_order:'asc'}}}})
    try{require('./sourceVerification').assertEngagementQuoteSnapshot(quote&&{...quote,lines:require('../../services/commercialDocumentFulfillment').netDocumentLines(quote)},e)}
    catch(error){if(error.code!=='SOURCE_REVIEW_REQUIRED')throw error;sourceChanged=true}
  }
  const money=!lockMoney&&knownMoney?knownMoney:await engagementMoney(db,e)
  const scheduling=await inspectPaymentScheduling(db,scope,e,now)
  const reviewRequired=sourceChanged||!!e.resolution_pending||!!e.commercial_snapshot?.replacementEngagementId||e.refunds.some(r=>r.status==='REQUESTED')||!!await engagementCurrencyReason(db,scope,e)
  const state=evaluateEventPaymentTerms({terms:e.event_payment_terms,reference:e.event_payment_reference,money,scheduling,reviewRequired,now})
  const reviewHash=createHash('sha256').update(JSON.stringify({terms:readEventPaymentTermsSnapshot(e.event_payment_terms),reference:state.reference,version:e.version,money,
    scheduling:scheduling.context,refunds:e.refunds.map(r=>({id:r.id,status:r.status,amount:String(r.amount)})),reviewRequired,confirmation:state.confirmation,payment:state.payment})).digest('hex')
  return {...state,reviewHash}
}
function paymentPolicyPublicState(state,{financial}){
  const out={...state,reasons:[...state.reasons],reference:state.reference?{...state.reference}:null}
  if(!financial)for(const key of ['depositRequired','depositMissing','paid','remaining','reviewHash'])delete out[key]
  return out
}
function parsePaymentException(raw,action){
  if(raw===undefined)return {}
  const v=require('./domain/validation')
  if(!['START','COMPLETE','CONFIRM_COMPLETION'].includes(action))v.invalid('exception','La excepción solo autoriza una acción de prestación del servicio')
  const input=v.object(raw,['reason','reviewHash']),reason=v.text(input.reason,'exception.reason',500)
  if(typeof input.reviewHash!=='string'||!/^[a-f0-9]{64}$/.test(input.reviewHash))v.invalid('exception.reviewHash','Revisa las condiciones actuales antes de autorizar')
  return {exception:{reason,reviewHash:input.reviewHash}}
}
async function actionPaymentStates(db,scope,{sessionId,bookingId,now}){
  if(db._runtimeDataModel&&!db._runtimeDataModel.models?.AppointmentEngagement?.fields.some(f=>f.name==='event_payment_terms'))return []
  const links=await db.appointmentEngagementSchedule.findMany({where:{company_id:scope.companyId,state:{not:'RELEASED'},
    ...(bookingId?{OR:[{booking_id:bookingId},{session_id:sessionId,kind:'SESSION',booking_id:null}]}:{session_id:sessionId,booking_id:null})},include:{line:{include:{engagement:true}}}})
  const ids=[...new Set(links.filter(l=>l.line?.engagement?.event_payment_terms).map(l=>l.engagement_id))].sort()
  const {loadPaymentEngagement}=require('./engagementPaymentReference'),states=[]
  for(const id of ids){const e=await loadPaymentEngagement(db,scope,id);states.push({e,state:await loadEngagementPaymentState(db,scope,e,{now,lockMoney:true})})}
  return states
}
async function assertEngagementPaymentAction(db,scope,input){
  if(!['CONFIRM','START','COMPLETE','CONFIRM_COMPLETION'].includes(input.action))return
  const rows=await actionPaymentStates(db,scope,input)
  const blocked=rows.filter(({state})=>input.action==='CONFIRM'?state.confirmation!=='CONFIRMED':!state.canStart)
  const canOverride=blocked.length>0&&blocked.every(({state})=>state.confirmation==='CONFIRMED'&&state.payment==='OVERDUE')&&
    hasAgendaPermission(scope,'appointments.override_payment_policy')&&hasAgendaPermission(scope,'receivables.view')&&input.action!=='CONFIRM'
  const reviewHash=createHash('sha256').update(JSON.stringify({sessionId:input.sessionId,bookingId:input.bookingId||null,action:input.action,states:rows.map(({e,state})=>({id:e.id,hash:state.reviewHash}))})).digest('hex')
  if(input.exception){
    const {exception}=parsePaymentException(input.exception,input.action)
    if(!hasAgendaPermission(scope,'appointments.override_payment_policy')||!hasAgendaPermission(scope,'receivables.view'))fail(403,'FORBIDDEN','Necesitas autorización para exceptuar un saldo vencido')
    if(exception.reviewHash!==reviewHash||!canOverride)fail(409,'PAYMENT_POLICY_REVIEW_CHANGED','Las condiciones cambiaron. Revisa de nuevo antes de autorizar esta acción')
    for(const {e}of blocked)await db.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:e.branch_id,customer_id:e.customer_id,engagement_id:e.id,actor_id:scope.userId,
      action:'PAYMENT_POLICY_EXCEPTION',reason:exception.reason,request_key:input.idempotencyKey,input_hash:reviewHash,after:{action:input.action,sessionId:input.sessionId,bookingId:input.bookingId||null,reviewHash}}})
    return
  }
  if(blocked.length)fail(409,'EVENT_PAYMENT_CONDITIONS_REQUIRED',blocked.some(({state})=>state.payment==='OVERDUE')?'El acuerdo tiene saldo vencido. Regulariza el cobro o solicita una excepción autorizada para esta acción':'Completa la programación, el anticipo o la revisión del acuerdo antes de continuar',{
    paymentPolicyCanOverride:String(canOverride),...(canOverride?{paymentPolicyReviewHash:reviewHash}:{}),paymentPolicyReasons:JSON.stringify([...new Set(blocked.flatMap(({state})=>state.reasons))])})
}
module.exports={loadEngagementPaymentState,paymentPolicyPublicState,inspectPaymentScheduling,activeSchedules,parsePaymentException,assertEngagementPaymentAction,actionPaymentStates}
