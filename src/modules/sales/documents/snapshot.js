const {id,lock,resolveProfiles}=require('../../config/documentTemplates/service')
const {LIMITS}=require('../../config/documentTemplates/contract')
const {fail}=require('../../config/documentTemplates/permissions')
const {operationScope,originPermission,has}=require('../../config/hardware/operations')
const {lockPrintBranding}=require('../../config/hardware/printing/branding')
const {documentData}=require('./data')
async function authorizeSaleDocument(db,scope,saleId,{includeData=false}={}) {
  operationScope(scope);originPermission(scope,'RECEIPT');id(saleId)
  const sale=await db.sale.findFirst({where:{id:saleId,branch_id:scope.branchId,branch:{company_id:scope.companyId}},...(includeData?{include:{status:true,sale_items:true,cashRegisterSession:{select:{cash_register_id:true}},payment_method:{select:{name:true}},branch:{include:{company:{select:{name:true,tax_id:true,address:true,logo_url:true}}}}}}:{select:{id:true,created_by:true}})})
  if(!sale||sale.created_by!==scope.actorId&&!['sales.view','sales.view_detail','sales.view_invoice'].some(p=>has(scope,p)))throw fail(404,'Venta no encontrada')
  return sale
}
async function prepareSaleSnapshot(db,scope,{saleId,purpose='INTERNAL_RECEIPT'}) {
  if(purpose!=='INTERNAL_RECEIPT')throw fail(409,'El certificador fiscal aún no está conectado','FISCAL_CONNECTOR_UNAVAILABLE')
  operationScope(scope);id(saleId)
  return db.$transaction(async tx=>{
    await lock(tx,`document-original:${scope.companyId}:${scope.branchId}:${saleId}:${purpose}`)
    const sale=await authorizeSaleDocument(tx,scope,saleId,{includeData:true})
    const where={company_id:scope.companyId,branch_id:scope.branchId,sale_id:saleId,purpose,source_kind:'SALE'}
    const existing=await tx.documentSnapshot.findFirst({where})
    if(existing)return existing
    if(sale.status?.name!=='Completada')throw fail(409,'Confirma la venta antes de preparar un documento','SALE_NOT_CONFIRMED')
    await lockPrintBranding(tx)
    const settingsRows=await tx.systemSetting.findMany({where:{company_id:scope.companyId,key:{in:['company_name','company_nit','company_address','company_logo_url','currency_code','invoices.appearance']}}})
    const settings=Object.fromEntries(settingsRows.map(r=>[r.key,r.value]))
    const profiles=await resolveProfiles(tx,scope,purpose),data=documentData(sale,settings)
    const appearance=settings['invoices.appearance']?JSON.parse(settings['invoices.appearance']):{}
    const branding={logoRef:settings.company_logo_url||sale.branch.company?.logo_url||'',cashRegisterId:sale.cashRegisterSession?.cash_register_id||null,preferredFormat:appearance.preferredFormat==='A4'?'A4':'LETTER'}
    const snapshot={...where,actor_id:scope.actorId,data,profiles,branding}
    if(Buffer.byteLength(JSON.stringify(snapshot))>LIMITS.snapshotBytes)throw fail(413,'El documento excede los datos admitidos')
    return tx.documentSnapshot.create({data:snapshot})
  },{maxWait:10000,timeout:15000})
}
module.exports={authorizeSaleDocument,prepareSaleSnapshot}
