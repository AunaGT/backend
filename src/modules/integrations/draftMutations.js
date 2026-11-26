const {randomUUID}=require('node:crypto')
const {performance}=require('node:perf_hooks')
const {Prisma}=require('@prisma/client')
const {fail}=require('./credentials')
const {parseDraftKey}=require('./draftInput')
const {parseMutationInput,parseIfMatch,mutationInputHash}=require('./draftMutationInput')
const {revalidateDocumentContext}=require('./policy')
const {loadOwnedDraft,assertMutableDraft,formatDocumentVersion}=require('./draftDocument')
const {buildDraftLines}=require('./draftLines')
const {recordDraftMutation,recordUsageInTransaction}=require('./audit')

async function activeContact(tx,context,id,{lock=false}={}){
 if(lock)await tx.$executeRaw`SELECT id FROM public.suppliers WHERE id=${id}::uuid AND company_id=${context.companyId}::uuid FOR SHARE`
 if(!await tx.supplier.findFirst({where:{id,company_id:context.companyId,party_type:'CUSTOMER',estado:1,deleted:false},select:{id:true}}))fail(409,'CUSTOMER_REVIEW_REQUIRED')
}
function mutationReceipt(document,currency){
 const money=v=>new Prisma.Decimal(String(v??'0')).toFixed(2)
 return{id:document.id,reference:document.reference,type:document.doc_type,status:document.status,branchId:document.branch_id,subtotal:money(document.subtotal),discountTotal:money(document.discount_total),total:money(document.total),currency,updatedAt:new Date(document.updated_at).toISOString(),version:formatDocumentVersion(document.integration_revision)}
}
async function mutateIntegrationDraft(db,context,type,id,action,raw,rawKey,rawIfMatch,{now=new Date(),requestId=null,requestedBranchId=null}={}){
 const input=parseMutationInput(action,raw),key=parseDraftKey(rawKey),version=parseIfMatch(rawIfMatch),hash=mutationInputHash(type,id.toLowerCase(),action,input,version)
 const started=performance.now(),authorizationNow=()=>new Date(now.getTime()+Math.floor(performance.now()-started))
 return db.$transaction(async tx=>{
  let fresh=await revalidateDocumentContext(tx,context,type,action,null,authorizationNow())
  const lock=`integration-mutation:${fresh.companyId}:${fresh.integrationId}:${id.toLowerCase()}:${action}:${key}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock},0))`
  const {operation,document}=await loadOwnedDraft(tx,fresh,type,id,{lock:true})
  fresh=await revalidateDocumentContext(tx,context,type,action,document.branch_id,authorizationNow())
  if(requestedBranchId!==null&&requestedBranchId!==document.branch_id)fail(403,'FORBIDDEN')
  const existing=await tx.integrationDraftMutation.findFirst({where:{company_id:fresh.companyId,integration_id:fresh.integrationId,document_id:document.id,action,request_key:key},select:{input_hash:true,receipt:true}})
  const route=(type==='QUOTE'?'/quotes/:id':'/orders/:id')+(action==='CANCEL_DRAFT'?'/cancel':'')
  if(existing){
   if(existing.input_hash!==hash)fail(409,'IDEMPOTENCY_CONFLICT')
   fresh=await revalidateDocumentContext(tx,context,type,action,document.branch_id,authorizationNow(),{lockCredential:true})
   await recordUsageInTransaction(tx,fresh,{route,status:200,branchId:document.branch_id,requestId},now)
   return{receipt:existing.receipt,replayed:true}
  }
  assertMutableDraft(document,{replaceItems:Object.hasOwn(input,'items')})
  if(formatDocumentVersion(document.integration_revision)!==version)fail(412,'VERSION_CONFLICT')
  await activeContact(tx,fresh,document.customer_contact_id)
  const amounts=input.items?await buildDraftLines(tx,fresh,type,input.items,now):null
  // Contact changes may block here; authorize only after that wait has ended.
  await activeContact(tx,fresh,document.customer_contact_id,{lock:true})
  fresh=await revalidateDocumentContext(tx,context,type,action,document.branch_id,authorizationNow(),{lockCredential:true})
  if(amounts?.lines.some(l=>l.item_kind==='SERVICE')&&!fresh.servicesEnabled||amounts?.lines.some(l=>l.unit_metadata_version===2)&&!fresh.unitsEnabled)fail(403,'FORBIDDEN')
  const data={updated_at:now}
  if(action==='CANCEL_DRAFT')data.status='CANCELLED'
  else{
   if(Object.hasOwn(input,'notes'))data.notes=input.notes
   if(amounts){
    if(document.event_payment_terms){
     const storage=require('../../services/eventPaymentTermsStorage')
     Object.assign(data,await storage.prepareEventPaymentTermsWrite(tx,{companyId:fresh.companyId},{raw:undefined,existing:document,total:amounts.total,hasServices:amounts.lines.some(l=>l.item_kind==='SERVICE'),currencyCode:fresh.currency}))
    }
    await tx.commercialDocumentLine.deleteMany({where:{document_id:document.id}})
    Object.assign(data,{subtotal:amounts.subtotal,discount_total:'0.00',total:amounts.total,unit_metadata_version:amounts.lines.some(l=>l.unit_metadata_version===2)?2:1,lines:{create:amounts.lines}})
   }
  }
  await tx.commercialDocument.update({where:{id:document.id},data,select:{id:true}})
  // Nested line triggers run after the header write: read the final revision.
  const saved=await tx.commercialDocument.findFirst({where:{id:document.id,branch_id:document.branch_id,doc_type:type},select:{id:true,reference:true,doc_type:true,status:true,branch_id:true,subtotal:true,discount_total:true,total:true,updated_at:true,integration_revision:true}})
  const receipt=mutationReceipt(saved,operation.currency_code)
  if(Buffer.byteLength(JSON.stringify(receipt))>4096)fail(503,'UNAVAILABLE')
  await tx.integrationDraftMutation.create({data:{id:randomUUID(),company_id:fresh.companyId,integration_id:fresh.integrationId,credential_id:fresh.credentialId,branch_id:document.branch_id,document_id:document.id,action,request_key:key,input_hash:hash,receipt,created_at:now}})
  await recordDraftMutation(tx,fresh,{documentId:document.id,type,action,branchId:document.branch_id,requestId},now)
  return{receipt,replayed:false}
 },{maxWait:15000,timeout:30000})
}
module.exports={mutateIntegrationDraft}
