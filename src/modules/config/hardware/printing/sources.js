const {fail,uuid}=require('../validation')
const {operationScope,originPermission,has}=require('../operations')
const {assertAccess}=require('../../../inventory/barcodeLabels/access')
function boundedSnapshot(value){const json=JSON.stringify(value);if(Buffer.byteLength(json)>2*1024*1024)fail(400,'Divide la impresión: el documento supera el tamaño permitido');return JSON.parse(json)}
async function authorizeSource(db,scope,source){
  const tenant=operationScope(scope);uuid(source.id,'source.id')
  originPermission(scope,source.kind==='SALE_TICKET'?'RECEIPT':'LABEL')
  if(source.kind==='SALE_TICKET'){
    const sale=await db.sale.findFirst({where:{id:source.id,branch_id:scope.branchId,branch:{company_id:scope.companyId}}})
    if(!sale||(!['sales.view','sales.view_detail','sales.view_invoice'].some(p=>has(scope,p))&&sale.created_by!==scope.actorId))fail(404,'Venta no encontrada')
    return sale
  }
  if(source.kind!=='LABEL_PREPARATION')fail(400,'Origen no admitido')
  await assertAccess(db,{...scope,userId:scope.actorId},{write:true})
  const preparation=await db.barcodePrintPreparation.findFirst({where:{...tenant,id:source.id,actor_id:scope.actorId}})
  if(!preparation)fail(404,'Preparación no encontrada')
  return preparation
}
async function resolvePrintSource(db,scope,source){
  const row=await authorizeSource(db,scope,source)
  if(source.kind==='LABEL_PREPARATION'){
    const p=row.snapshot
    if(!p||p.id!==row.id||p.companyId!==scope.companyId||p.actorId!==scope.actorId||!Array.isArray(p.products)||!p.products.length||!p.design||!p.paper)fail(409,'La preparación guardada no es válida')
    return boundedSnapshot({version:1,renderer:'LABELS_V1',prepared:p})
  }
  const sale=await db.sale.findFirst({where:{id:row.id,branch_id:scope.branchId,branch:{company_id:scope.companyId}},include:{cashRegisterSession:{select:{cash_register_id:true}},payment_method:true,status:true,sale_items:{include:{product:{select:{name:true}}}},sale_dtes:true,paymentEntries:{select:{amount:true}},createdBy:{select:{name:true}}}})
  if(!sale||!sale.sale_items?.length)fail(409,'La venta no tiene un documento válido')
  const settings=await db.systemSetting.findMany({where:{company_id:scope.companyId,key:{in:['company_name','company_nit','company_logo_url','locale','currency_code']}}}),values=Object.fromEntries(settings.map(s=>[s.key,s.value]))
  const company=await db.company.findFirst({where:{id:scope.companyId},select:{name:true}})
  // Only document fields, never contact credentials, product internals or the incoming request.
  const fields=['id','reference','date','customer','customer_nit','is_final_consumer','subtotal','discount_total','total','adjusted_total','status','amount_received','change','payment_method','paymentEntries','sale_dtes','due_date','settlement_source','createdBy']
  const document=Object.fromEntries(fields.filter(k=>sale[k]!==undefined).map(k=>[k,sale[k]]))
  document.sale_items=sale.sale_items.map(i=>({item_name:i.item_name||i.product?.name,unit_label:i.unit_label,qty:i.qty,price:i.price}))
  return boundedSnapshot({version:1,renderer:'SALE_TICKET_V1',cashRegisterId:sale.cashRegisterSession?.cash_register_id||null,sale:document,options:{companyName:values.company_name||company?.name||'',companyNit:values.company_nit||'',locale:values.locale||'es-GT',currencyCode:values.currency_code||'GTQ',logoUrl:values.company_logo_url||''}})
}
module.exports={boundedSnapshot,authorizeSource,resolvePrintSource}
