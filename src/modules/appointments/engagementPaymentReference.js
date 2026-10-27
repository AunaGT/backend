const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const v=require('./domain/validation')
const {lockCustomer,engagementMoney}=require('../receivables')
const {readEventPaymentTermsSnapshot,eventPaymentDueAt}=require('../../services/eventPaymentTerms')

function paymentReferencePlan(e){
  const terms=readEventPaymentTermsSnapshot(e.event_payment_terms)
  if(!terms)return null
  const before=e.event_payment_reference||{startsAt:terms.referenceStartsAt,timezone:terms.referenceTimezone}
  const baseline={startsAt:terms.referenceStartsAt,timezone:terms.referenceTimezone}
  const services=e.lines.filter(l=>l.item_kind==='SERVICE'),schedules=services.flatMap(l=>l.schedules.filter(s=>s.state!=='RELEASED'))
  const valid=s=>s.state!=='CANCELLED'&&s.session.status!=='CANCELLED'&&!['CANCELLED','EXPIRED','NO_SHOW'].includes(s.booking?.status)
  const active=schedules.filter(valid).map(s=>({startsAt:s.session.starts_at.toISOString(),timezone:s.session.timezone})).sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||a.timezone.localeCompare(b.timezone))
  const complete=services.length>0&&services.every(l=>l.schedules.filter(s=>s.state!=='RELEASED'&&valid(s)).reduce((n,s)=>n.add(s.quantity),new Prisma.Decimal(0)).eq(l.qty))
  const earliest=active[0]
  const candidate=complete&&earliest?earliest:[baseline,...active].sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0]
  // An incomplete/cancelled scope must not extend an already agreed deadline by omission.
  const lostFirst=!!e.event_payment_reference&&!active.some(s=>Date.parse(s.startsAt)===Date.parse(before.startsAt))
  const preserve=!complete&&lostFirst&&Date.parse(candidate.startsAt)>Date.parse(before.startsAt)
  const after=preserve?before:candidate
  return {before,after,dueBefore:eventPaymentDueAt(terms,before),dueAfter:eventPaymentDueAt(terms,after),changed:Date.parse(before.startsAt)!==Date.parse(after.startsAt)||before.timezone!==after.timezone,
    reviewRequired:preserve||schedules.some(s=>!valid(s)),complete}
}
const paymentInclude={lines:{orderBy:{sort_order:'asc'},include:{schedules:{include:{session:true,booking:true}}}},refunds:true}
async function loadPaymentEngagement(db,scope,id){
  const row=await db.appointmentEngagement.findFirst({where:{id,company_id:scope.companyId,branch_id:scope.branchId||{in:scope.branchIds}},include:paymentInclude})
  if(!row)v.fail(404,'NOT_FOUND','Contratación no encontrada')
  return row
}
async function linkedPaymentEngagementIds(db,scope,{engagementIds=[],sessionIds=[],bookingIds=[]}){
  if(engagementIds.length)return [...new Set(engagementIds)].sort()
  if(!sessionIds.length&&!bookingIds.length)return []
  if(db._runtimeDataModel&&!db._runtimeDataModel.models?.AppointmentEngagement?.fields.some(f=>f.name==='event_payment_terms'))return []
  const links=await db.appointmentEngagementSchedule.findMany({where:{company_id:scope.companyId,state:{not:'RELEASED'},OR:[...(sessionIds.length?[{session_id:{in:sessionIds}}]:[]),...(bookingIds.length?[{booking_id:{in:bookingIds}}]:[])]},
    include:{line:{include:{engagement:true}}}})
  return [...new Set(links.filter(l=>l.line?.engagement?.event_payment_terms).map(l=>l.engagement_id))].sort()
}
async function reviewEngagementPaymentReferences(db,scope,input){
  const ids=await linkedPaymentEngagementIds(db,scope,input),pending=[]
  // Acquire all quote/customer locks in a stable order before taking engagement row locks.
  const initial=await Promise.all(ids.map(id=>loadPaymentEngagement(db,scope,id)))
  for(const e of initial.filter(e=>e.event_payment_terms).sort((a,b)=>(a.quote_id||'').localeCompare(b.quote_id||'')))await require('./sourceVerification').lockEngagementQuote(db,scope,e,{internal:true})
  for(const customer of [...new Set(initial.filter(e=>e.event_payment_terms).map(e=>e.customer_id))].sort())await lockCustomer(db,customer)
  for(const e of initial){
    if(!e.event_payment_terms)continue
    await db.$queryRaw`SELECT id FROM appointment_engagements WHERE id=${e.id}::uuid AND company_id=${scope.companyId}::uuid FOR UPDATE`
    const current=await loadPaymentEngagement(db,scope,e.id),plan=paymentReferencePlan(current)
    if(!plan.changed)continue
    const money=await engagementMoney(db,current)
    const schedules=current.lines.flatMap(l=>l.schedules.map(s=>({lineId:l.id,quantity:String(s.quantity),kind:s.kind,state:s.state,startsAt:s.session.starts_at.toISOString(),endsAt:s.session.ends_at.toISOString(),timezone:s.session.timezone}))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
    pending.push({e:current,plan,context:{id:e.id,version:current.version,terms:current.event_payment_terms,reference:current.event_payment_reference,money,schedules}})
  }
  if(!pending.length)return
  const hash=createHash('sha256').update(JSON.stringify(pending.map(p=>p.context))).digest('hex')
  if(input.acknowledgedPaymentReviewHash!==hash)v.fail(409,'PAYMENT_REFERENCE_REVIEW_REQUIRED','La primera prestación cambia el vencimiento del acuerdo. Revisa las fechas antes de guardar',{
    acknowledgedPaymentReviewHash:hash,paymentReferenceReview:JSON.stringify(pending.map(({plan})=>({before:plan.before,after:plan.after,dueBefore:plan.dueBefore,dueAfter:plan.dueAfter})))})
  for(const {e,plan}of pending){
    await db.appointmentEngagement.update({where:{id:e.id},data:{event_payment_reference:plan.after,version:{increment:1}}})
    await db.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:e.branch_id,customer_id:e.customer_id,engagement_id:e.id,actor_id:scope.userId,
      action:'PAYMENT_REFERENCE_REVIEWED',reason:input.reason||'Referencia revisada al programar',request_key:hash,input_hash:hash,before:{reference:plan.before,dueAt:plan.dueBefore},after:{reference:plan.after,dueAt:plan.dueAfter}}})
  }
}
function parsePaymentReview(raw){
  if(raw===undefined)return {}
  if(typeof raw!=='string'||!/^[a-f0-9]{64}$/.test(raw))v.invalid('acknowledgedPaymentReviewHash','Revisa de nuevo el vencimiento del acuerdo')
  return {acknowledgedPaymentReviewHash:raw}
}
module.exports={paymentReferencePlan,reviewEngagementPaymentReferences,loadPaymentEngagement,linkedPaymentEngagementIds,parsePaymentReview}
