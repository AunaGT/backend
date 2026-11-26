const {fail,advancedProduct,authorize,unitsEnabled,lockProduct,revision,factorText}=require('./access')
const {calculateUnitLine,unitPrice,validateSnapshot}=require('./calculation')
async function resolveUnitLine(tx,scope,passedProduct,input,{operation='SALE',snapshot=null,frozen_unit_price=null,authorization=null}={}) {
  if(!['SALE','PURCHASE'].includes(operation))fail(400,'Operación de unidad inválida')
  if(authorization!==null&&(!['RETURN_REPLACEMENT','APPOINTMENT_SOURCE'].includes(authorization)||operation!=='SALE'))fail(400,'Contexto interno de autorización inválido')
  if(authorization==='APPOINTMENT_SOURCE'){authorize(scope,['appointments.create'],true);authorize(scope,['products.view'])}
  else authorize(scope,authorization==='RETURN_REPLACEMENT'?['returns.manage','returns.approve','returns.complete']:operation==='PURCHASE'?['products.register_incoming']:['sales.create','orders.create','quotes.create'],true)
  if(!input||['factor','base_qty','unit_snapshot','unit_metadata_version','frozen_unit_price','authorization','authorization_context'].some(k=>Object.hasOwn(input,k)))fail(400,'El servidor determina la conversión y el snapshot')
  if(frozen_unit_price!=null&&!snapshot)fail(400,'El precio congelado requiere un snapshot aprobado')
  if(passedProduct.company_id&&passedProduct.company_id!==scope.companyId)fail(404,'Producto no encontrado')
  const product=passedProduct.base_unit_id||snapshot||await unitsEnabled(tx,scope.companyId)?await lockProduct(tx,scope,passedProduct.id):passedProduct
  if(!advancedProduct(product)&&!snapshot)return calculateUnitLine(product,{operation},input)
  if(operation==='SALE'&&product.available_for_sale===false)fail(400,'El producto no está disponible para venta')
  let frozen,presentation=null
  if(snapshot)frozen=validateSnapshot(snapshot,product)
  else {
    revision(product,input.unit_revision)
    const base=await require('../../../services/checkoutContext').checkoutUnit(tx,scope.companyId,product.base_unit_id,()=>tx.measureUnit.findFirst({where:{id:product.base_unit_id,company_id:scope.companyId}}))
    if(!base)fail(404,'Unidad base no encontrada')
    const id=input.presentation_id===undefined?(operation==='PURCHASE'?product.default_purchase_presentation_id:product.default_sale_presentation_id):input.presentation_id
    if(id){presentation=await require('../../../services/checkoutContext').checkoutPresentation(tx,scope.companyId,product.id,id,()=>tx.productPresentation.findFirst({where:{id,company_id:scope.companyId,product_id:product.id,active:true}}));if(!presentation)fail(404,'Presentación no encontrada');if(!(operation==='PURCHASE'?presentation.purchase_enabled:presentation.sale_enabled))fail(400,'Presentación no habilitada para esta operación')}
    frozen={version:2,baseUnit:{id:base.id,code:base.code,name:base.name,label:base.label,decimals:product.quantity_decimals},presentation:presentation?{id:presentation.id,version:presentation.version,name:presentation.name,label:presentation.label,decimals:presentation.quantity_decimals}:null,factor:presentation?factorText(presentation.factor):'1',roundingDelta:'0'}
    frozen=validateSnapshot(frozen,product)
  }
  return calculateUnitLine(product,{presentation,snapshot:frozen,frozenUnitPrice:frozen_unit_price,operation},input)
}
module.exports={resolveUnitLine,unitPrice}
