const {createHash}=require('node:crypto')
const v=require('../appointments/domain/validation')
const {saleCommercialView}=require('./commercialState')

async function fiscalEnabled(db,companyId){
  const rows=await db.systemSetting.findMany({where:{company_id:companyId,key:'fel_enabled'},select:{value:true}})
  return String(rows[0]?.value||'false').trim().toLowerCase()==='true'
}
function parseFiscalRequest(raw){
  const p=v.object(raw,['expectedVersion','idempotencyKey'])
  return {expectedVersion:v.version(p.expectedVersion),idempotencyKey:v.uuid(p.idempotencyKey,'idempotencyKey')}
}
async function loadSale(tx,scope,id){
  const sale=await tx.sale.findFirst({where:{id,branch_id:scope.branchId,branch:{company_id:scope.companyId}},include:{status:true,sale_dtes:true}})
  if(!sale)v.fail(404,'NOT_FOUND','Venta no encontrada en esta sucursal')
  if(sale.status.name!=='Completada')v.fail(409,'SALE_NOT_CONFIRMED','Confirma la venta antes de solicitar su factura')
  return sale
}
async function recordRequest(tx,scope,sale,{key,inputHash,source}){
  const doc=await tx.saleDte.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:sale.id,status:'PENDING_CONNECTOR'}})
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:sale.id,actor_id:scope.userId,action:'FISCAL_REQUESTED',request_key:key,input_hash:inputHash,
    after:{documentId:doc.id,state:'PENDING_CONNECTOR',source,connectorAvailable:false}}})
  await tx.sale.update({where:{id:sale.id,version:sale.version},data:{version:{increment:1}}})
  return doc
}
// Called only by the owner creating a NEW POS sale, never from GET or configuration changes.
async function preparePosFiscalRequest(tx,scope,newSale){
  if(!await fiscalEnabled(tx,scope.companyId))return null
  const sale=await loadSale(tx,scope,newSale.id)
  if(sale.origin_engagement_id)v.fail(409,'INVALID_FISCAL_ORIGIN','La automatización del POS no corresponde a esta contratación')
  if(sale.sale_dtes.length)return sale.sale_dtes[0]
  const key=`pos:${sale.id}`,inputHash=createHash('sha256').update(key).digest('hex')
  return recordRequest(tx,scope,sale,{key,inputHash,source:'POS'})
}
async function requestFiscalInvoice(db,scope,saleId,raw){
  if(!scope.branchId)v.fail(400,'BRANCH_REQUIRED','Selecciona una sucursal para solicitar la factura')
  if(!scope.isAdmin&&!scope.permissions.includes('sales.fiscal.register'))v.fail(403,'FORBIDDEN','No tienes permiso para solicitar facturas')
  v.uuid(saleId,'saleId');const input=parseFiscalRequest(raw)
  const hash=createHash('sha256').update(JSON.stringify({saleId,...input})).digest('hex')
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`appointments:${scope.companyId}`},0))`
    const modules=require('../platform/registry').resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
    if(!modules.some(m=>m.code==='sales'&&m.effectiveEnabled))v.fail(403,'MODULE_DISABLED','Ventas no está habilitado en esta empresa')
    const locked=await tx.$queryRaw`SELECT s.id FROM sales s JOIN branches b ON b.id=s.branch_id WHERE s.id=${saleId}::uuid AND s.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid FOR UPDATE OF s`
    if(!locked.length)v.fail(404,'NOT_FOUND','Venta no encontrada en esta sucursal')
    const sale=await loadSale(tx,scope,saleId)
    const previous=await tx.saleHistory.findUnique({where:{company_id_actor_id_action_request_key:{company_id:scope.companyId,actor_id:scope.userId,action:'FISCAL_REQUESTED',request_key:input.idempotencyKey}}})
    if(previous){
      if(previous.sale_id!==sale.id||previous.input_hash!==hash)v.fail(409,'IDEMPOTENCY_CONFLICT','Este intento ya se utilizó con otros datos')
      return saleCommercialView(sale)
    }
    if(!await fiscalEnabled(tx,scope.companyId))v.fail(409,'FISCAL_DISABLED','Activa la facturación electrónica en Configuración → Datos fiscales')
    const state=saleCommercialView(sale).fiscalState
    if(state==='PENDING_CONNECTOR')return saleCommercialView(sale)
    if(state!=='UNRECORDED')v.fail(409,'FISCAL_DOCUMENT_EXISTS','Esta venta ya tiene documentación fiscal; revísala antes de solicitar otra factura')
    if(sale.version!==input.expectedVersion)v.fail(409,'STALE_VERSION','La venta cambió; actualiza el detalle antes de continuar')
    await recordRequest(tx,scope,sale,{key:input.idempotencyKey,inputHash:hash,source:'MANUAL'})
    return saleCommercialView(await loadSale(tx,scope,saleId))
  },{timeout:30000,maxWait:5000})
}
module.exports={fiscalEnabled,parseFiscalRequest,preparePosFiscalRequest,requestFiscalInvoice}
