const v=require('../appointments/domain/validation')
function documentComplete(d){return ['document_type','authorization','series','number'].every(key=>typeof d[key]==='string'&&d[key].trim())&&d.emission_date&&Number.isFinite(new Date(d.emission_date).getTime())}
function fiscalState(documents){
  if(!documents.length)return 'UNRECORDED'
  if(documents.every(d=>d.status==='PENDING_CONNECTOR'&&!d.provider&&!d.authorization&&!d.series&&!d.number&&!d.emission_date&&!d.xml_url&&!d.pdf_url))return 'PENDING_CONNECTOR'
  let external=false
  for(const d of documents){
    if(!documentComplete(d))return 'REVIEW_REQUIRED'
    if(d.provider==='EXTERNAL'&&d.status==='RECORDED_EXTERNAL')external=true
    else if(!d.provider||d.provider==='EXTERNAL'||!['AUTHORIZED','AUTORIZADO','CERTIFIED','CERTIFICADO'].includes(String(d.status).toUpperCase()))return 'REVIEW_REQUIRED'
  }
  return external?'RECORDED_EXTERNAL':'AUTHORIZED'
}
function documentText(value,key,max){
  const result=v.text(value,key,max)
  if(/[\u0000-\u001f\u007f]/.test(result))v.invalid(key,'Usa un identificador sin caracteres de control')
  return result
}
function parseExternalInvoice(raw,correction=false){
  const p=v.object(raw,['expectedVersion','idempotencyKey','documentType','authorization','series','number','date','observation',...(correction?['reason']:[])])
  const date=v.text(p.date,'date',10)
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)v.invalid('date','Indica una fecha de emisión válida')
  return {expectedVersion:v.version(p.expectedVersion),idempotencyKey:v.uuid(p.idempotencyKey,'idempotencyKey'),documentType:documentText(p.documentType,'documentType',50),
    authorization:documentText(p.authorization,'authorization',100),series:documentText(p.series,'series',20),number:documentText(p.number,'number',50),date,
    observation:v.text(p.observation,'observation',2000,false),...(correction?{reason:v.text(p.reason,'reason',500)}:{})}
}
function fiscalAuthority(scope){
  if(!scope.branchId)v.fail(400,'BRANCH_REQUIRED','Selecciona una sucursal para registrar el documento')
  if(!scope.isAdmin&&!scope.permissions.includes('sales.fiscal.register'))v.fail(403,'FORBIDDEN','No tienes permiso para registrar documentos fiscales externos')
}
function evidence(document,observation){return {...JSON.parse(JSON.stringify(document)),normalizedAuthorization:document.authorization.trim().toLowerCase(),...(observation!==undefined?{observation}:{})}}
async function externalInvoiceCommand(db,scope,saleId,documentId,raw){
  fiscalAuthority(scope);v.uuid(saleId,'saleId');if(documentId)v.uuid(documentId,'documentId')
  const input=parseExternalInvoice(raw,!!documentId),action=documentId?'EXTERNAL_INVOICE_CORRECTED':'EXTERNAL_INVOICE_REGISTERED'
  const normalized=input.authorization.toLowerCase(),{createHash}=require('node:crypto')
  const inputHash=createHash('sha256').update(JSON.stringify({saleId,documentId:documentId||null,...input,authorization:normalized})).digest('hex')
  try{return await db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`appointments:${scope.companyId}`},0))`
    const modules=require('../platform/registry').resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
    if(!modules.some(m=>m.code==='sales'&&m.effectiveEnabled))v.fail(403,'MODULE_DISABLED','Ventas no está habilitado en esta empresa')
    const locked=await tx.$queryRaw`SELECT s.id FROM sales s JOIN branches b ON b.id=s.branch_id WHERE s.id=${saleId}::uuid AND s.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid FOR UPDATE OF s`
    if(!locked.length)v.fail(404,'NOT_FOUND','Venta no encontrada en esta sucursal')
    const sale=await tx.sale.findUnique({where:{id:saleId},include:{status:true,sale_dtes:true}})
    const previous=await tx.saleHistory.findUnique({where:{company_id_actor_id_action_request_key:{company_id:scope.companyId,actor_id:scope.userId,action,request_key:input.idempotencyKey}}})
    if(previous){
      if(previous.input_hash!==inputHash||previous.sale_id!==saleId)v.fail(409,'IDEMPOTENCY_CONFLICT','Ese intento ya se utilizó con otros datos')
      return require('./commercialState').saleCommercialView(sale)
    }
    if(sale.status.name!=='Completada')v.fail(409,'SALE_NOT_CONFIRMED','Confirma comercialmente la venta antes de registrar su factura externa')
    if(sale.version!==input.expectedVersion)v.fail(409,'STALE_VERSION','La venta cambió; actualiza sus datos antes de continuar')
    const old=documentId?sale.sale_dtes.find(d=>d.id===documentId):null
    if(documentId&&(!old||old.provider!=='EXTERNAL'||old.status!=='RECORDED_EXTERNAL'))v.fail(409,'EXTERNAL_DOCUMENT_REQUIRED','Solo puedes corregir el registro de una factura externa; no anula un documento legal')
    const duplicate=await tx.$queryRaw`SELECT id FROM sale_dtes WHERE company_id=${scope.companyId}::uuid AND lower(btrim("authorization"))=${normalized} AND (${documentId||null}::uuid IS NULL OR id<>${documentId||null}::uuid) LIMIT 1`
    const historical=await tx.saleHistory.findFirst({where:{company_id:scope.companyId,sale_id:{not:saleId},action:{in:['EXTERNAL_INVOICE_REGISTERED','EXTERNAL_INVOICE_CORRECTED']},OR:[{before:{path:['normalizedAuthorization'],equals:normalized}},{after:{path:['normalizedAuthorization'],equals:normalized}}]},select:{id:true}})
    if(duplicate.length||historical)v.fail(409,'EXTERNAL_DOCUMENT_EXISTS','Este identificador fiscal ya está vinculado a una venta de la empresa')
    const data={company_id:scope.companyId,branch_id:scope.branchId,sale_id:saleId,document_type:input.documentType,authorization:input.authorization,
      series:input.series,number:input.number,emission_date:new Date(input.date+'T00:00:00.000Z'),provider:'EXTERNAL',status:'RECORDED_EXTERNAL'}
    const document=old?await tx.saleDte.update({where:{id:old.id},data}):await tx.saleDte.create({data})
    await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:saleId,actor_id:scope.userId,action,request_key:input.idempotencyKey,input_hash:inputHash,
      ...(old?{before:evidence(old)}:{}),after:evidence(document,input.observation),reason:input.reason||null}})
    const updated=await tx.sale.update({where:{id:saleId,version:input.expectedVersion},data:{version:{increment:1}},include:{status:true,sale_dtes:true}})
    return require('./commercialState').saleCommercialView(updated)
  },{timeout:30000,maxWait:5000})}catch(error){
    if(error.code==='P2002')v.fail(409,'EXTERNAL_DOCUMENT_EXISTS','Este identificador fiscal ya está registrado')
    throw error
  }
}
async function registerExternalInvoice(db,scope,saleId,raw){return externalInvoiceCommand(db,scope,saleId,null,raw)}
async function correctExternalInvoice(db,scope,saleId,documentId,raw){return externalInvoiceCommand(db,scope,saleId,documentId,raw)}
module.exports={fiscalState,parseExternalInvoice,registerExternalInvoice,correctExternalInvoice}
