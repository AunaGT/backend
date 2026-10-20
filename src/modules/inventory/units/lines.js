const {parseQuantity,convertQuantity,lineTotal}=require('../../../services/units/quantity')
const {Prisma}=require('@prisma/client')
const {commercialQuantity,lineSnapshot}=require('../../../services/catalogItemRules')
const {fail,advancedProduct,authorize,unitsEnabled,lockProduct,revision,decimals,text,factorText}=require('./access')
function unitPrice(product,presentation,tier='LIST',factor='1',now=new Date()) {
  if(!['LIST','WHOLESALE','PROMOTION'].includes(tier))fail(400,'Tarifa inválida')
  const key=tier==='WHOLESALE'?'price_wholesale':tier==='PROMOTION'?'price_promotion':'price'
  const active=row=>tier!=='PROMOTION'||!row?.promotion_valid_until||new Date(row.promotion_valid_until)>=now
  const override=active(presentation)?presentation?.[key]:null
  if(override!=null)return parseQuantity(override,{decimals:6,allowZero:true,max:'9999999999.99'}).toFixed()
  const alternate=product[key]==null?null:parseQuantity(product[key],{decimals:6,allowZero:true,max:'9999999999.99'})
  const base=active(product)&&alternate&&(key==='price'||alternate.gt(0))?alternate:product.price
  const result=parseQuantity(base??'0',{decimals:6,allowZero:true,max:'9999999999.99'}).mul(factorText(factor))
  if(result.gt('9999999999.99'))fail(400,'Precio derivado fuera de rango')
  return result.toFixed()
}
function validateSnapshot(snapshot,product) {
  if(!snapshot||snapshot.version!==2||!snapshot.baseUnit||!(snapshot.presentation===null||typeof snapshot.presentation==='object'))fail(400,'Snapshot de unidad inválido')
  const b=snapshot.baseUnit
  for(const key of ['id','code','name','label'])text(b[key],`baseUnit.${key}`,100)
  decimals(b.decimals,product.kind==='SERVICE'?4:product.kind==='KIT'?0:6)
  if(snapshot.presentation){const p=snapshot.presentation;for(const key of ['id','name','label'])text(p[key],`presentation.${key}`,100);decimals(p.decimals,product.kind==='SERVICE'?4:6);if(!Number.isSafeInteger(p.version)||p.version<1)fail(400,'Versión de presentación inválida')}
  parseQuantity(snapshot.factor,{decimals:12,max:'99999999.999999999999'})
  const delta=snapshot.roundingDelta
  if(typeof delta!=='string'||delta.length>128||!(/^-?\d+(?:\.\d{1,18})?$/).test(delta)||new Prisma.Decimal(delta).abs().gt('1'))fail(400,'Residuo de conversión inválido')
  if(product.base_unit_id!==b.id)fail(409,'La unidad base no corresponde al producto')
  return structuredClone(snapshot)
}
async function resolveUnitLine(tx,scope,passedProduct,input,{operation='SALE',snapshot=null,frozen_unit_price=null,authorization=null}={}) {
  if(!['SALE','PURCHASE'].includes(operation))fail(400,'Operación de unidad inválida')
  if(authorization!==null&&(!['RETURN_REPLACEMENT','APPOINTMENT_SOURCE'].includes(authorization)||operation!=='SALE'))fail(400,'Contexto interno de autorización inválido')
  if(authorization==='APPOINTMENT_SOURCE'){authorize(scope,['appointments.create'],true);authorize(scope,['products.view'])}
  else authorize(scope,authorization==='RETURN_REPLACEMENT'?['returns.manage']:operation==='PURCHASE'?['products.register_incoming']:['sales.create','orders.create','quotes.create'],true)
  if(!input||['factor','base_qty','unit_snapshot','unit_metadata_version','frozen_unit_price','authorization','authorization_context'].some(k=>Object.hasOwn(input,k)))fail(400,'El servidor determina la conversión y el snapshot')
  if(frozen_unit_price!=null&&!snapshot)fail(400,'El precio congelado requiere un snapshot aprobado')
  if(passedProduct.company_id&&passedProduct.company_id!==scope.companyId)fail(404,'Producto no encontrado')
  const product=passedProduct.base_unit_id||snapshot||await unitsEnabled(tx,scope.companyId)?await lockProduct(tx,scope,passedProduct.id):passedProduct
  if(!advancedProduct(product)&&!snapshot){
    if(input.presentation_id!=null)fail(409,'Recarga el producto antes de elegir una presentación')
    const qty=commercialQuantity(input.qty,product).toFixed(),legacy=lineSnapshot(product)
    return {qty,base_qty:qty,unit_metadata_version:1,unit_snapshot:{version:1,factor:'1',unit_label:legacy.unit_label},...legacy,...(operation==='SALE'?{unit_price:unitPrice(product,null,input.price_tier)}:{})}
  }
  if(operation==='SALE'&&product.available_for_sale===false)fail(400,'El producto no está disponible para venta')
  let frozen,presentation=null
  if(snapshot)frozen=validateSnapshot(snapshot,product)
  else {
    revision(product,input.unit_revision)
    const base=await tx.measureUnit.findFirst({where:{id:product.base_unit_id,company_id:scope.companyId}})
    if(!base)fail(404,'Unidad base no encontrada')
    const id=input.presentation_id===undefined?(operation==='PURCHASE'?product.default_purchase_presentation_id:product.default_sale_presentation_id):input.presentation_id
    if(id){presentation=await tx.productPresentation.findFirst({where:{id,company_id:scope.companyId,product_id:product.id,active:true}});if(!presentation)fail(404,'Presentación no encontrada');if(!(operation==='PURCHASE'?presentation.purchase_enabled:presentation.sale_enabled))fail(400,'Presentación no habilitada para esta operación')}
    frozen={version:2,baseUnit:{id:base.id,code:base.code,name:base.name,label:base.label,decimals:product.quantity_decimals},presentation:presentation?{id:presentation.id,version:presentation.version,name:presentation.name,label:presentation.label,decimals:presentation.quantity_decimals}:null,factor:presentation?factorText(presentation.factor):'1',roundingDelta:'0'}
    frozen=validateSnapshot(frozen,product)
  }
  const precision=frozen.presentation?.decimals??frozen.baseUnit.decimals
  const qty=parseQuantity(input.qty,{decimals:precision}).toFixed()
  const converted=convertQuantity(qty,frozen.factor,{baseDecimals:frozen.baseUnit.decimals,commercialDecimals:precision,allowRounding:input.accept_rounding===true})
  frozen.roundingDelta=converted.roundingDelta
  const line={qty,base_qty:converted.baseQty,unit_metadata_version:2,unit_snapshot:frozen,item_name:product.name,item_kind:product.kind??'STANDARD',unit_label:frozen.presentation?.label??frozen.baseUnit.label,quantity_decimals:precision,unit_revision:product.unit_revision}
  if(operation==='SALE'){
    line.unit_price=frozen_unit_price!=null?new Prisma.Decimal(String(frozen_unit_price)).toFixed():unitPrice(product,presentation,input.price_tier,frozen.factor)
    line.line_total=lineTotal(qty,line.unit_price)
  }
  return line
}
module.exports={resolveUnitLine,unitPrice}
