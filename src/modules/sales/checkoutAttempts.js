const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const fail=(message,status,code)=>Object.assign(new Error(message),{status,code})
function checkoutKey(req){
  const value=req.get?.('Idempotency-Key')||req.body?.idempotency_key
  if(value==null||value==='')return null
  if(typeof value!=='string'||!value.trim()||value.trim().length>64)throw fail('Clave de cobro no válida',400,'INVALID_CHECKOUT_KEY')
  return value.trim()
}
const numeric=new Set(['price','qty','amount','amount_received','change','payment_method_id'])
function canonical(value,key=''){
  if(value==null)return null
  if(numeric.has(key)){
    try{const n=new Prisma.Decimal(String(value));if(!n.isFinite())throw Error();return n.toFixed()}catch{throw fail('Importe o cantidad no válida',400,'INVALID_CHECKOUT_VALUE')}
  }
  if(Array.isArray(value))return value.map(v=>canonical(v))
  if(typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k],k)]))
  return value
}
function checkoutHash(kind,input,orderId=null){
  const keys=kind==='ORDER'?['payment_method_id','amount_received','change','lines','cash_register_id','due_date','initial_payment','credit_override']:['customer','customer_nit','is_final_consumer','payment_method_id','customer_contact_id','sales_channel','cash_register_id','items','amount_received','change','admin_authorized_products','promotion_codes','due_date','initial_payment','credit_override']
  const body=Object.fromEntries(keys.filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))
  return createHash('sha256').update(JSON.stringify(canonical({kind,orderId,body}))).digest('hex')
}
function assertCheckoutReplay(sale,scope,hash){
  if(sale.created_by!==scope.user.sub)throw fail('La clave de cobro pertenece a otra operación',409,'CHECKOUT_CONFLICT')
  if(!sale.idempotency_hash)throw fail('Comprueba el resultado del cobro anterior antes de continuar',409,'LEGACY_ATTEMPT_REQUIRES_RECOVERY')
  if(sale.idempotency_hash!==hash)throw fail('El intento ya corresponde a otro cobro. Comprueba su resultado.',409,'CHECKOUT_CONFLICT')
  return sale
}
async function lockCheckoutAttempt(tx,branchId,key){
  if(key)await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${branchId}:${key}`},0))::text`
}
async function lookupCheckoutAttempt(db,scope,key){
  if(!scope.branchId||scope.branchId==='all')throw fail('Selecciona una sucursal',400,'BRANCH_REQUIRED')
  const validKey=checkoutKey({body:{idempotency_key:key}})
  if(!validKey)throw fail('Clave de cobro no válida',400,'INVALID_CHECKOUT_KEY')
  const sale=await db.sale.findFirst({where:{branch_id:scope.branchId,branch:{company_id:scope.companyId},created_by:scope.user.sub,idempotency_key:validKey},select:{id:true,orderLink:{select:{document_id:true}}}})
  if(!sale)throw fail('El resultado del cobro aún no está disponible',404,'CHECKOUT_NOT_OBSERVED')
  return {state:'CONFIRMED',saleId:sale.id,kind:sale.orderLink?'ORDER':'SALE',...(sale.orderLink?{orderId:sale.orderLink.document_id}:{})}
}
module.exports={checkoutKey,checkoutHash,assertCheckoutReplay,lockCheckoutAttempt,lookupCheckoutAttempt}
