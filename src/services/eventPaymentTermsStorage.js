const {Prisma}=require('@prisma/client')
const {fail}=require('../modules/appointments/domain/validation')
const {money}=require('../modules/receivables/domain/paymentAllocations')
const {parseEventPaymentTerms,freezeEventPaymentTerms,readEventPaymentTermsSnapshot}=require('./eventPaymentTerms')

async function eventPaymentStorageReady(db){
  // Test doubles have no generated model; real clients need both the new model and migrated columns.
  if(!db._runtimeDataModel)return true
  for(const name of ['CommercialDocument','Sale','AppointmentEngagement']){
    const fields=db._runtimeDataModel.models?.[name]?.fields
    if(!fields?.some(f=>f.name==='event_payment_terms')||name==='AppointmentEngagement'&&!fields.some(f=>f.name==='event_payment_reference'))return false
  }
  const [row]=await db.$queryRaw`SELECT count(*)::int AS total FROM information_schema.columns WHERE table_schema='public' AND
    ((table_name IN ('commercial_documents','sales','appointment_engagements') AND column_name='event_payment_terms') OR
     (table_name='appointment_engagements' AND column_name='event_payment_reference'))`
  return Number(row?.total)===4
}
async function assertEventPaymentStorage(db){
  if(!await eventPaymentStorageReady(db))fail(409,'EVENT_PAYMENT_TERMS_NOT_READY','Las condiciones de anticipo necesitan la actualización del sistema. Solicita al administrador que la aplique antes de usarlas')
}
function termsInput(snapshot){
  const terms=readEventPaymentTermsSnapshot(snapshot)
  if(!terms)return null
  const {basisTotal,currencyCode,...input}=terms
  return input
}
async function prepareEventPaymentTermsWrite(db,scope,{raw,existing,total,hasServices,currencyCode}){
  if(raw===undefined&&existing?.event_payment_terms==null||raw===null&&existing?.event_payment_terms==null)return {}
  await assertEventPaymentStorage(db)
  const input=raw===undefined?termsInput(existing.event_payment_terms):parseEventPaymentTerms(raw)
  if(input&&!hasServices)fail(400,'EVENT_TERMS_REQUIRE_SERVICE','Estas condiciones requieren al menos un servicio. Para productos usa las condiciones de pago habituales')
  const currency=currencyCode??(await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}}))?.value??'GTQ'
  return {event_payment_terms:freezeEventPaymentTerms(input,{total:String(total),currencyCode:currency})??Prisma.DbNull}
}
function copyEventPaymentTerms(source){
  const terms=readEventPaymentTermsSnapshot(source.event_payment_terms??source.eventPaymentTerms)
  return terms?{event_payment_terms:terms}:{}
}
function assertEventPaymentAgreement(row){
  const terms=readEventPaymentTermsSnapshot(row.event_payment_terms??row.eventPaymentTerms)
  if(terms&&!money(String(row.agreed_total??row.total)).eq(terms.basisTotal))fail(409,'EVENT_PAYMENT_TERMS_REVIEW_REQUIRED','El total cambió respecto de las condiciones acordadas. Revisa la propuesta antes de continuar')
}
module.exports={eventPaymentStorageReady,assertEventPaymentStorage,prepareEventPaymentTermsWrite,copyEventPaymentTerms,assertEventPaymentAgreement,termsInput}
