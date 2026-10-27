const {Prisma}=require('@prisma/client')
const {DateTime}=require('luxon')
const v=require('../modules/appointments/domain/validation')
const {money}=require('../modules/receivables/domain/paymentAllocations')
const keys=['schemaVersion','depositPercent','balanceDaysBefore','referenceStartsAt','referenceTimezone']

function parseEventPaymentTerms(raw){
  if(raw===null)return null
  const input=v.object(raw,keys)
  if(input.schemaVersion!==1)v.invalid('eventPaymentTerms','La versión de las condiciones no es compatible')
  if(typeof input.depositPercent!=='string'||!/^\d{1,3}(?:\.\d{1,2})?$/.test(input.depositPercent)||new Prisma.Decimal(input.depositPercent).gt(100))
    v.invalid('eventPaymentTerms.depositPercent','Indica un anticipo entre 0 y 100 %, con hasta dos decimales')
  if(typeof input.referenceStartsAt!=='string'||input.referenceStartsAt.length>40)v.invalid('eventPaymentTerms.referenceStartsAt','Indica fecha, hora y zona de la primera prestación')
  return {schemaVersion:1,depositPercent:new Prisma.Decimal(input.depositPercent).toFixed(2),
    balanceDaysBefore:v.integer(input.balanceDaysBefore,'eventPaymentTerms.balanceDaysBefore',0,365),
    referenceStartsAt:v.instant(input.referenceStartsAt,'eventPaymentTerms.referenceStartsAt'),referenceTimezone:v.zone(input.referenceTimezone)}
}
function freezeEventPaymentTerms(input,{total,currencyCode}){
  const terms=parseEventPaymentTerms(input)
  if(!terms)return null
  if(typeof currencyCode!=='string'||!/^[A-Z]{3}$/.test(currencyCode))v.invalid('eventPaymentTerms','La moneda del acuerdo no es válida')
  return {...terms,basisTotal:money(total).toFixed(2),currencyCode}
}
function readEventPaymentTermsSnapshot(raw){
  if(raw==null)return null
  v.object(raw,[...keys,'basisTotal','currencyCode'])
  return freezeEventPaymentTerms(Object.fromEntries(keys.map(key=>[key,raw[key]])),{total:raw.basisTotal,currencyCode:raw.currencyCode})
}
function paymentReference(terms,reference){
  if(reference==null)return {startsAt:terms.referenceStartsAt,timezone:terms.referenceTimezone}
  v.object(reference,['startsAt','timezone'])
  return {startsAt:v.instant(reference.startsAt,'eventPaymentReference.startsAt'),timezone:v.zone(reference.timezone)}
}
function eventPaymentDueAt(snapshot,reference){
  const terms=readEventPaymentTermsSnapshot(snapshot)
  if(!terms)return null
  const at=paymentReference(terms,reference)
  return DateTime.fromISO(at.startsAt,{zone:at.timezone}).minus({days:terms.balanceDaysBefore}).toUTC().toISO()
}
function evaluateEventPaymentTerms({terms:snapshot,reference,money:amounts,scheduling,reviewRequired=false,now}){
  const terms=readEventPaymentTermsSnapshot(snapshot)
  if(!terms)return {enabled:false,confirmation:'NOT_APPLICABLE',payment:'NOT_APPLICABLE',dueAt:null,reference:null,
    depositRequired:'0.00',depositMissing:'0.00',paid:'0.00',remaining:'0.00',canStart:true,canComplete:true,reasons:[]}
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))v.invalid('now','La hora de revisión no es válida')
  const basis=money(terms.basisTotal),paid=money(amounts.committed).add(money(amounts.applied)),remaining=money(amounts.remaining)
  const deposit=basis.mul(terms.depositPercent).div(100).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP)
  const missing=Prisma.Decimal.max(0,deposit.sub(paid)),dueAt=eventPaymentDueAt(terms,reference)
  const needsReview=reviewRequired||!money(amounts.total).eq(basis)||paid.gt(basis)||!scheduling?.valid
  const overdue=remaining.gt(0)&&now.getTime()>=new Date(dueAt).getTime()
  const confirmation=needsReview?'REVIEW_REQUIRED':!scheduling?.complete?'PENDING_SCHEDULE':missing.gt(0)?'PENDING_DEPOSIT':'CONFIRMED'
  const reasons=[...(needsReview?['COMMERCIAL_REVIEW_REQUIRED']:[]),...(!scheduling?.complete?['SCHEDULE_INCOMPLETE']:[]),
    ...(missing.gt(0)?['DEPOSIT_PENDING']:[]),...(overdue?['BALANCE_OVERDUE']:[])]
  return {enabled:true,confirmation,payment:remaining.eq(0)?'PAID':overdue?'OVERDUE':paid.gt(0)?'PARTIAL':'PENDING',dueAt,
    reference:paymentReference(terms,reference),depositRequired:deposit.toFixed(2),depositMissing:missing.toFixed(2),paid:paid.toFixed(2),remaining:remaining.toFixed(2),
    canStart:confirmation==='CONFIRMED'&&!overdue,canComplete:confirmation==='CONFIRMED'&&!overdue,reasons}
}
function publicEventPaymentTerms(snapshot){
  const terms=readEventPaymentTermsSnapshot(snapshot)
  if(!terms)return null
  return {depositPercent:terms.depositPercent,depositRequired:money(terms.basisTotal).mul(terms.depositPercent).div(100).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toFixed(2),
    balanceDaysBefore:terms.balanceDaysBefore,referenceStartsAt:terms.referenceStartsAt,referenceTimezone:terms.referenceTimezone,dueAt:eventPaymentDueAt(terms,null),currencyCode:terms.currencyCode}
}
module.exports={parseEventPaymentTerms,freezeEventPaymentTerms,readEventPaymentTermsSnapshot,eventPaymentDueAt,evaluateEventPaymentTerms,publicEventPaymentTerms}
