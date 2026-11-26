const {fail,object,uuid}=require('./credentials')
const {normalizeTaxId,resolveContactForEntityKind}=require('../contacts/contactInput')
const fields=['externalId','entityKind','name','contact','taxId','email','phone','address']
const tax=v=>normalizeTaxId(v)?.toUpperCase()??null
const genericTaxId=v=>['','CF','NA','CONSUMIDORFINAL','XAXX010101000','XEXX010101000'].includes(String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,''))
function customerText(raw,max,required=false){
 if(raw==null){if(required)fail(400);return null}
 if(typeof raw!=='string'||raw.trim().length>max||/[\x00-\x1f\x7f]/.test(raw)||required&&!raw.trim())fail(400)
 return raw.trim()||null
}
function parseCustomerReference(raw){
 object(raw,fields)
 const out={externalId:customerText(raw.externalId,100,true)}
 if(raw.entityKind!==undefined){if(!['PERSON','ORGANIZATION'].includes(raw.entityKind))fail(400);out.entityKind=raw.entityKind}
 for(const [k,max] of Object.entries({name:150,contact:100,taxId:50,email:150,phone:50,address:2000}))if(raw[k]!==undefined)out[k]=customerText(raw[k],max)
 if(out.taxId)out.taxId=tax(out.taxId)
 if(out.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email))fail(400)
 return out
}
function eligible(row){return row&&row.party_type==='CUSTOMER'&&row.estado===1&&!row.deleted}
function review(){fail(409,'CUSTOMER_REVIEW_REQUIRED')}
const selection={id:true,name:true,tax_id:true,entity_kind:true,party_type:true,estado:true,deleted:true}
const result=(r,created=false)=>({id:r.id,name:r.name,taxId:r.tax_id??null,created})
function identityMatches(row,input){if(input.entityKind&&row.entity_kind!==input.entityKind||input.taxId!==undefined&&!genericTaxId(input.taxId)&&tax(row.tax_id)!==tax(input.taxId))review()}
async function resolveDraftCustomer(tx,context,inputCustomer,now=new Date()){
 object(inputCustomer,['customerId','customer'])
 if(!!inputCustomer.customerId===!!inputCustomer.customer)fail(400)
 if(inputCustomer.customerId){
  if(!uuid(inputCustomer.customerId))fail(400)
  const row=await tx.supplier.findFirst({where:{id:inputCustomer.customerId,company_id:context.companyId,party_type:'CUSTOMER',estado:1,deleted:false},select:selection})
  if(!eligible(row))fail(404,'NOT_FOUND')
  return result(row)
 }
 const input=parseCustomerReference(inputCustomer.customer),specificTax=!genericTaxId(input.taxId)?tax(input.taxId):null
 const labels=[`integration-customer:${context.companyId}:${context.integrationId}:${input.externalId}`,...(specificTax?[`integration-customer-tax:${context.companyId}:${specificTax}`]:[])].sort()
 for(const label of labels)await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${label},0))`
 const ref=await tx.integrationCustomerReference.findUnique({where:{company_id_integration_id_external_id:{company_id:context.companyId,integration_id:context.integrationId,external_id:input.externalId}}})
 if(ref){const row=await tx.supplier.findFirst({where:{id:ref.customer_id,company_id:context.companyId},select:selection});if(!eligible(row))review();identityMatches(row,input);return result(row)}
 if(context.customerPolicy!=='CREATE_IF_MISSING'||!context.scopes.includes('customers.create'))fail(403,'FORBIDDEN')
 if(!Number.isSafeInteger(context.customerPaymentTermId)||!await tx.paymentTerm.findFirst({where:{id:context.customerPaymentTermId,company_id:context.companyId,deleted:false},select:{id:true}}))fail(403,'FORBIDDEN')
 let row
 if(specificTax){
  const matches=await tx.$queryRaw`SELECT id,name,tax_id,entity_kind,party_type,estado,deleted FROM suppliers WHERE company_id=${context.companyId}::uuid AND party_type='CUSTOMER' AND upper(btrim(tax_id))=${specificTax} LIMIT 2`
  if(matches.length>1||matches.length===1&&!eligible(matches[0]))review()
  row=matches[0];if(row)identityMatches(row,input)
 }
 let created=false
 if(!row){
  if(!input.entityKind)fail(400)
  const profile=resolveContactForEntityKind({entityKind:input.entityKind,name:input.name,contact:input.contact})
  if(!profile.ok||profile.contact.length>100)fail(400)
  row=await tx.supplier.create({data:{company_id:context.companyId,party_type:'CUSTOMER',entity_kind:input.entityKind,name:profile.name,contact:profile.contact,tax_id:input.taxId??null,email:input.email??null,phone:input.phone??null,address:input.address??null,estado:1,deleted:false,default_price_tier:'LIST',credit_limit:'0',supplier_payment_terms:{create:[{payment_term_id:context.customerPaymentTermId,is_default:true,sort_order:0}]}},select:selection});created=true
 }
 await tx.integrationCustomerReference.create({data:{company_id:context.companyId,integration_id:context.integrationId,external_id:input.externalId,customer_id:row.id,created_at:now}})
 return result(row,created)
}
module.exports={resolveDraftCustomer,parseCustomerReference,genericTaxId}
