function fail(code,status,message) { throw Object.assign(new Error(message),{code,status}) }
function requireCompany(companyId) {
  if(typeof companyId!=='string'||!companyId.trim()) fail('PM_COMPANY_REQUIRED',403,'Selecciona una empresa')
}
function methodId(value) {
  if(!['number','string'].includes(typeof value)||!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)>2147483647)
    fail('PM_KIND_INVALID',400,'Método de pago inválido')
  return Number(value)
}
function ownerWhere(companyId) { return {OR:[{company_id:null},{company_id:companyId}]} }
function preferenceWhere(companyId,id) {
  requireCompany(companyId)
  return {company_id:companyId,...(id===undefined?{}:{payment_method_id:methodId(id)}),payment_method:ownerWhere(companyId)}
}
function dto(pref) {
  const m=pref.payment_method
  return {id:m.id,name:m.name,is_credit:m.is_credit,settlement_kind:m.settlement_kind??null,
    enabled:pref.enabled,position:pref.position,origin:m.company_id?'COMPANY':m.base_code?'BASIC':'LEGACY_SHARED'}
}
async function lockPaymentMethods(tx,companyId,mode='read') {
  requireCompany(companyId)
  const key=`payment-methods:${companyId}`
  if(mode==='write') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))`
}
async function getPreference(db,companyId,id) {
  const pref=await db.companyPaymentMethod.findFirst({where:preferenceWhere(companyId,id),include:{payment_method:true}})
  if(!pref||!pref.payment_method||(pref.payment_method.company_id!=null&&pref.payment_method.company_id!==companyId))
    fail('PM_NOT_FOUND',404,'Método de pago no encontrado')
  return pref
}
async function resolvePaymentMethod(tx,{companyId,methodId:id,purpose}) {
  requireCompany(companyId);id=methodId(id)
  if(!['SALE','CREDIT_SALE','RECEIPT','SUPPLIER_PAYMENT','REFUND'].includes(purpose)) fail('PM_KIND_INVALID',400,'Finalidad de pago inválida')
  await lockPaymentMethods(tx,companyId)
  const pref=await getPreference(tx,companyId,id),m=pref.payment_method
  if(!pref.enabled) fail('PM_DISABLED',409,'Este método está desactivado. Reactívalo o selecciona otro medio de pago')
  if(purpose==='CREDIT_SALE'?!m.is_credit:purpose!=='SALE'&&m.is_credit)
    fail('PM_KIND_INVALID',400,'Selecciona un método válido para esta operación; crédito no representa dinero recibido')
  return m
}
async function listPaymentMethodChoices(db,companyId,{includeInactive=false}={}) {
  const rows=await db.companyPaymentMethod.findMany({where:{...preferenceWhere(companyId),...(includeInactive?{}:{enabled:true})},include:{payment_method:true},orderBy:[{position:'asc'},{payment_method_id:'asc'}]})
  if(!rows.length&&await db.companyPaymentMethod.count({where:preferenceWhere(companyId)})===0)
    fail('PM_SETUP_REQUIRED',409,'Esta empresa no tiene métodos inicializados. Revisa su configuración de pagos')
  return rows.map(dto)
}
async function findHistoricalPaymentMethod(db,companyId,id) {return (await getPreference(db,companyId,id)).payment_method}
async function firstActiveCreditMethod(tx,companyId) {
  await lockPaymentMethods(tx,companyId)
  const pref=await tx.companyPaymentMethod.findFirst({where:{...preferenceWhere(companyId),enabled:true,payment_method:{...ownerWhere(companyId),is_credit:true}},include:{payment_method:true},orderBy:[{position:'asc'},{payment_method_id:'asc'}]})
  if(!pref) fail('PM_KIND_INVALID',400,'Activa un método de venta a crédito para confirmar una venta con saldo pendiente')
  if(pref.payment_method.company_id!=null&&pref.payment_method.company_id!==companyId)fail('PM_NOT_FOUND',404,'Método de pago no encontrado')
  return pref.payment_method
}
module.exports={lockPaymentMethods,resolvePaymentMethod,listPaymentMethodChoices,findHistoricalPaymentMethod,firstActiveCreditMethod,
  preferenceWhere,getPreference,dto,fail,methodId}
