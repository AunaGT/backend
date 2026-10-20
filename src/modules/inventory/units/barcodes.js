const {fail,authorize,assertEnabled}=require('./access')
function normalizeCode(raw) { if(typeof raw!=='string'||!raw.trim()||raw.trim().length>100)fail(400,'Código de barras inválido');return raw.trim() }
async function assertCodeAvailable(tx,scope,raw,{productId,presentationId=null}={}) {
  const code=normalizeCode(raw)
  const reserved=await tx.productBarcode.findFirst({where:{company_id:scope.companyId,code}})
  if(reserved&&(reserved.product_id!==productId||(reserved.presentation_id??null)!==presentationId))fail(409,'El código ya está reservado por otro producto o presentación','BARCODE_CONFLICT')
  // BTRIM also catches pre-feature codes saved with outer spaces; deleted products keep their codes reserved.
  const ownBase=presentationId===null?productId??null:null
  const legacy=tx.$queryRaw
    ? (await tx.$queryRaw`SELECT id FROM products WHERE company_id=${scope.companyId}::uuid AND btrim(barcode)=${code} AND (${ownBase}::uuid IS NULL OR id<>${ownBase}::uuid) LIMIT 1`)[0]
    : await tx.product.findFirst({where:{company_id:scope.companyId,barcode:code}})
  if(legacy&&(legacy.id!==productId||presentationId!==null))fail(409,'El código ya está reservado por otro producto','BARCODE_CONFLICT')
  return code
}
async function reserveCode(tx,scope,raw,{productId,presentationId=null}={}) {
  const code=await assertCodeAvailable(tx,scope,raw,{productId,presentationId})
  const previous=await tx.productBarcode.findFirst({where:{company_id:scope.companyId,code}})
  try {
    if(previous) return tx.productBarcode.update({where:{id:previous.id},data:{active:true}})
    return await tx.productBarcode.create({data:{company_id:scope.companyId,product_id:productId,presentation_id:presentationId,code,active:true}})
  }catch(error){if(error.code==='P2002')fail(409,'El código ya está reservado por otro producto o presentación','BARCODE_CONFLICT');throw error}
}
async function syncBaseBarcode(tx,scope,productId,raw) {
  await tx.productBarcode.updateMany({where:{company_id:scope.companyId,product_id:productId,presentation_id:null,active:true},data:{active:false}})
  if(raw!=null&&raw!=='')await reserveCode(tx,scope,raw,{productId})
}
async function resolveBarcode(db,scope,raw,{operation='SALE'}={}) {
  authorize(scope,['products.view','sales.create','products.register_incoming'])
  await assertEnabled(db,scope)
  const code=normalizeCode(raw)
  let row=await db.productBarcode.findFirst({where:{company_id:scope.companyId,code,active:true}})
  if(!row){const p=await db.product.findFirst({where:{company_id:scope.companyId,barcode:code,deleted:false}});if(p)row={product_id:p.id,presentation_id:null}}
  if(!row)fail(404,'Código no encontrado')
  const product=await db.product.findFirst({where:{id:row.product_id,company_id:scope.companyId,deleted:false}})
  if(!product)fail(404,'Producto no encontrado')
  if(row.presentation_id){const p=await db.productPresentation.findFirst({where:{id:row.presentation_id,company_id:scope.companyId,product_id:product.id,active:true}});if(!p||!(operation==='PURCHASE'?p.purchase_enabled:p.sale_enabled))fail(404,'Presentación no disponible')}
  return {product_id:product.id,presentation_id:row.presentation_id??null,unit_revision:product.unit_revision??1}
}
module.exports={normalizeCode,assertCodeAvailable,reserveCode,syncBaseBarcode,resolveBarcode}
