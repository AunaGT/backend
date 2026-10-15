const {lockPaymentMethods,getPreference,preferenceWhere,dto,fail,methodId}=require('./access')
function usageInclude(companyId) {
  return {_count:{select:{
    sales:{where:{branch:{company_id:companyId}}},customer_payments:{where:{branch:{company_id:companyId}}},
    supplier_payments:{where:{company_id:companyId}},cash_closure_payments:{where:{cash_closure:{branch:{company_id:companyId}}}},
    return_settlements:{where:{return:{sale:{branch:{company_id:companyId}}}}},customer_payment_refunds:{where:{company_id:companyId}},
  }}}
}
function payload(body,allowed) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail('PM_KIND_INVALID',400,'Campos de método de pago inválidos')
}
function nameOf(name) {
  if(typeof name!=='string'||!name.trim()||name.trim().length>50)fail('PM_KIND_INVALID',400,'Ingresa un nombre de 1 a 50 caracteres')
  return name.trim()
}
function positionOf(position) {
  if(!Number.isInteger(position)||position<0||position>1000000)fail('PM_KIND_INVALID',400,'El orden debe estar entre 0 y 1000000')
  return position
}
async function transaction(db,companyId,run) {
  try { return await db.$transaction(async tx=>{await lockPaymentMethods(tx,companyId,'write');return run(tx)},{timeout:30000,maxWait:15000}) }
  catch(e) {
    if(e.code==='P2002')fail('PM_NAME_CONFLICT',409,'Ya existe un método propio con ese nombre')
    if(e.code==='P2003')fail('PM_IN_USE',409,'El método tiene historial. Desactívalo en lugar de eliminarlo')
    throw e
  }
}
async function noCollision(tx,companyId,name,id) {
  const rows=await tx.companyPaymentMethod.findMany({where:{...preferenceWhere(companyId),enabled:true,...(id?{payment_method_id:{not:id}}:{})},include:{payment_method:true}})
  if(rows.some(r=>r.payment_method.name.trim().toLowerCase()===name.trim().toLowerCase()))fail('PM_NAME_CONFLICT',409,'Ya hay un medio activo con ese nombre')
}
async function keepEffective(tx,companyId,pref) {
  if(!pref.enabled||pref.payment_method.is_credit)return
  const remaining=await tx.companyPaymentMethod.count({where:{...preferenceWhere(companyId),enabled:true,payment_method_id:{not:pref.payment_method.id},payment_method:{...preferenceWhere(companyId).payment_method,is_credit:false}}})
  if(!remaining)fail('PM_LAST_EFFECTIVE',409,'Conserva al menos un medio activo que reciba dinero; Crédito no cuenta')
}
async function unused(tx,companyId,id) {
  const method=await tx.paymentMethod.findFirst({where:{id,...preferenceWhere(companyId).payment_method},include:usageInclude(companyId)})
  if(!method)fail('PM_NOT_FOUND',404,'Método no encontrado')
  if(Object.values(method._count).some(n=>n>0))fail('PM_IN_USE',409,'Este método tiene historial. Puedes desactivarlo o crear uno nuevo')
}
async function createCompanyPaymentMethod(db,companyId,body) {
  payload(body,['name','settlement_kind','position'])
  const name=nameOf(body.name),kind=body.settlement_kind
  if(!['CASH','BANK','CREDIT'].includes(kind))fail('PM_KIND_INVALID',400,'Selecciona efectivo, medio bancario o venta a crédito')
  if(body.position!==undefined)positionOf(body.position)
  return transaction(db,companyId,async tx=>{
    await noCollision(tx,companyId,name)
    const position=body.position??((await tx.companyPaymentMethod.aggregate({where:{company_id:companyId},_max:{position:true}}))._max.position??-1)+1
    const method=await tx.paymentMethod.create({data:{company_id:companyId,name,settlement_kind:kind,is_credit:kind==='CREDIT'}})
    const pref=await tx.companyPaymentMethod.create({data:{company_id:companyId,payment_method_id:method.id,enabled:true,position}})
    return {...dto({...pref,payment_method:method}),_count:{}}
  })
}
async function updateCompanyPaymentMethod(db,companyId,id,body) {
  id=methodId(id);payload(body,['name','enabled','position'])
  if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail('PM_KIND_INVALID',400,'Estado inválido')
  if(body.position!==undefined)positionOf(body.position)
  const name=body.name===undefined?undefined:nameOf(body.name)
  return transaction(db,companyId,async tx=>{
    const pref=await getPreference(tx,companyId,id),method=pref.payment_method
    if(name!==undefined&&method.company_id==null)fail('PM_SHARED_PROTECTED',409,'El nombre compartido está protegido. Crea un método propio')
    if(name!==undefined&&name!==method.name)await unused(tx,companyId,id)
    if((body.enabled??pref.enabled)&&(name!==undefined||body.enabled===true))await noCollision(tx,companyId,name??method.name,id)
    if(body.enabled===false)await keepEffective(tx,companyId,pref)
    if(name!==undefined)await tx.paymentMethod.update({where:{id},data:{name}})
    const data={};if(body.enabled!==undefined)data.enabled=body.enabled;if(body.position!==undefined)data.position=body.position
    const updated=await tx.companyPaymentMethod.update({where:{company_id_payment_method_id:{company_id:companyId,payment_method_id:id}},data})
    return dto({...pref,...updated,payment_method:{...method,...(name===undefined?{}:{name})}})
  })
}
async function deleteCompanyPaymentMethod(db,companyId,id) {
  id=methodId(id)
  return transaction(db,companyId,async tx=>{
    const pref=await getPreference(tx,companyId,id)
    if(pref.payment_method.company_id==null)fail('PM_SHARED_PROTECTED',409,'Los métodos compartidos no se eliminan; desactívalos para tu empresa')
    await unused(tx,companyId,id);await keepEffective(tx,companyId,pref)
    await tx.companyPaymentMethod.delete({where:{company_id_payment_method_id:{company_id:companyId,payment_method_id:id}}})
    await tx.paymentMethod.delete({where:{id}})
    return {ok:true}
  })
}
async function listPaymentMethodsCatalog(db,companyId,{page=1,pageSize=10,search='',order,state='all',includeSummary=false}={}) {
  if(!['all','active','inactive'].includes(state))fail('PM_KIND_INVALID',400,'Estado inválido')
  page=Math.max(1,Math.trunc(Number(page))||1);pageSize=Math.min(100,Math.max(1,Math.trunc(Number(pageSize))||10))
  search=String(search).trim()
  const where={...preferenceWhere(companyId),...(state==='all'?{}:{enabled:state==='active'})}
  if(search)where.payment_method={...where.payment_method,name:{contains:search,mode:'insensitive'}}
  const totalItems=await db.companyPaymentMethod.count({where}),totalPages=Math.max(1,Math.ceil(totalItems/pageSize)),safePage=Math.min(page,totalPages)
  if(totalItems===0&&await db.companyPaymentMethod.count({where:preferenceWhere(companyId)})===0)
    fail('PM_SETUP_REQUIRED',409,'Esta empresa no tiene métodos inicializados. Revisa su configuración de pagos')
  let summary
  if(includeSummary){
    const rows=await db.companyPaymentMethod.findMany({where,select:{enabled:true,payment_method:{select:{is_credit:true}}}})
    summary={total:totalItems,active:0,inactive:0,immediate:0,credit:0}
    for(const r of rows){summary[r.enabled?'active':'inactive']++;summary[r.payment_method.is_credit?'credit':'immediate']++}
  }
  const rows=await db.companyPaymentMethod.findMany({where,orderBy:[{payment_method:{name:order==='desc'?'desc':'asc'}},{payment_method_id:'asc'}],skip:(safePage-1)*pageSize,take:pageSize,include:{payment_method:{include:usageInclude(companyId)}}})
  return {items:rows.map(r=>({...dto(r),_count:r.payment_method._count})),page:safePage,pageSize,totalPages,totalItems,nextPage:safePage<totalPages?safePage+1:null,prevPage:safePage>1?safePage-1:null,...(summary?{summary}:{})}
}
module.exports={createCompanyPaymentMethod,updateCompanyPaymentMethod,deleteCompanyPaymentMethod,listPaymentMethodsCatalog,usageInclude}
