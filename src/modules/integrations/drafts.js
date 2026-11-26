const {randomUUID}=require('node:crypto')
const {performance}=require('node:perf_hooks')
const {fail}=require('./credentials')
const {parseDraftInput,parseDraftKey,draftInputHash}=require('./draftInput')
const {revalidateDraftContext}=require('./policy')
const {resolveDraftCustomer,genericTaxId}=require('./customers')
const {buildDraftLines}=require('./draftLines')
const {recordUsageInTransaction,recordDraftCreation}=require('./audit')
const {nextDocumentReference}=require('../../services/referenceGenerator')
const {getCommercialDocSettings}=require('../../services/commercialDocumentSettings')
async function createIntegrationDraft(db,context,type,raw,rawKey,{now=new Date(),requestId=null}={}){
 const input=parseDraftInput(raw),key=parseDraftKey(rawKey),hash=draftInputHash(type,input)
 const started=performance.now(),authorizationNow=()=>new Date(now.getTime()+Math.floor(performance.now()-started))
 return db.$transaction(async tx=>{
  let fresh=await revalidateDraftContext(tx,context,type,null,authorizationNow())
  const lock=`integration-draft:${fresh.companyId}:${fresh.integrationId}:${type}:${key}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))`
  const operation=await tx.integrationDraftOperation.findFirst({where:{company_id:fresh.companyId,integration_id:fresh.integrationId,type,request_key:key},select:{input_hash:true,receipt:true,document:{select:{branch_id:true}}}})
  if(operation){
   if(!operation.document||!fresh.branches.some(b=>b.id===operation.document.branch_id))fail(404,'NOT_FOUND')
   if(operation.input_hash!==hash)fail(409,'IDEMPOTENCY_CONFLICT')
   fresh=await revalidateDraftContext(tx,context,type,operation.document.branch_id,authorizationNow(),{lockCredential:true})
   await recordUsageInTransaction(tx,fresh,{route:type==='QUOTE'?'/quotes':'/orders',status:200,branchId:operation.document.branch_id,requestId},now)
   return{receipt:operation.receipt,replayed:true}
  }
  fresh=await revalidateDraftContext(tx,context,type,input.branchId,authorizationNow())
  const customer=await resolveDraftCustomer(tx,fresh,input.customerId?{customerId:input.customerId}:{customer:input.customer},now)
  const amounts=await buildDraftLines(tx,fresh,type,input.items,now)
  const branch=await tx.branch.findFirst({where:{id:input.branchId,company_id:fresh.companyId,active:true},select:{id:true,code:true,seq:true}})
  if(!branch)fail(403,'FORBIDDEN')
  const reference=await nextDocumentReference(tx,type==='QUOTE'?'Q':'P',branch),settings=await getCommercialDocSettings(tx,fresh.companyId)
  const days=type==='QUOTE'?settings.quoteValidityDays:settings.orderValidityDays,validUntil=new Date(now.getTime()+days*86400000)
  if(!Number.isFinite(validUntil.getTime()))fail(503,'UNAVAILABLE')
  if(customer.created&&!await tx.paymentTerm.findFirst({where:{id:fresh.customerPaymentTermId,company_id:fresh.companyId,deleted:false},select:{id:true}}))fail(403,'FORBIDDEN')
  // Serialize the final authorization against pause/revoke, not the entire preparation.
  fresh=await revalidateDraftContext(tx,context,type,input.branchId,authorizationNow(),{lockCredential:true})
  if(customer.created&&!fresh.scopes.includes('customers.create')||amounts.lines.some(l=>l.item_kind==='SERVICE')&&!fresh.servicesEnabled||amounts.lines.some(l=>l.unit_metadata_version===2)&&!fresh.unitsEnabled)fail(403,'FORBIDDEN')
  const doc=await tx.commercialDocument.create({data:{id:randomUUID(),branch_id:input.branchId,reference,doc_type:type,status:'DRAFT',sales_channel:'ONLINE',payment_condition:'CASH',customer_contact_id:customer.id,customer:customer.name,customer_nit:customer.taxId,is_final_consumer:genericTaxId(customer.taxId),created_by:fresh.ownerId,subtotal:amounts.subtotal,discount_total:'0.00',total:amounts.total,notes:input.notes??null,valid_until:validUntil,created_at:now,unit_metadata_version:amounts.lines.some(l=>l.unit_metadata_version===2)?2:1,...(type==='ORDER'?{fulfillment_mode:'SEPARATE'}:{}),lines:{create:amounts.lines}},select:{id:true}})
  const receipt={id:doc.id,reference,type,status:'DRAFT',branchId:input.branchId,externalReference:input.externalReference??null,subtotal:amounts.subtotal,discountTotal:'0.00',total:amounts.total,currency:fresh.currency,createdAt:now.toISOString(),validUntil:validUntil.toISOString()}
  await tx.integrationDraftOperation.create({data:{id:randomUUID(),company_id:fresh.companyId,integration_id:fresh.integrationId,credential_id:fresh.credentialId,branch_id:input.branchId,document_id:doc.id,type,request_key:key,input_hash:hash,receipt,currency_code:fresh.currency,external_reference:input.externalReference??null,created_at:now}})
  await recordDraftCreation(tx,fresh,{documentId:doc.id,type,branchId:input.branchId,requestId},now)
  return{receipt,replayed:false}
 },{maxWait:15000,timeout:30000})
}
module.exports={createIntegrationDraft}
