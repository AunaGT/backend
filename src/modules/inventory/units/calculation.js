const {parseQuantity,convertQuantity,lineTotal}=require('../../../services/units/quantity')
const {Prisma}=require('@prisma/client')
const {commercialQuantity,lineSnapshot}=require('../../../services/catalogItemRules')
const {fail,advancedProduct,decimals,text,factorText}=require('./access')
function publicPromotionSource(product,presentation,now=new Date()){
 const active=row=>row?.price_promotion!=null&&(!row.promotion_valid_until||new Date(row.promotion_valid_until)>=now)
 if(active(presentation))return presentation
 return active(product)&&new Prisma.Decimal(String(product.price_promotion)).gt(0)?product:null
}
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
function calculateUnitLine(product,{baseUnit=null,presentation=null,snapshot=null,frozenUnitPrice=null,operation='SALE',now=new Date()}={},input){
  if(!advancedProduct(product)&&!snapshot){
    if(input.presentation_id!=null)fail(409,'Recarga el producto antes de elegir una presentación')
    const qty=commercialQuantity(input.qty,product).toFixed(),legacy=lineSnapshot(product)
    return {qty,base_qty:qty,unit_metadata_version:1,unit_snapshot:{version:1,factor:'1',unit_label:legacy.unit_label},...legacy,...(operation==='SALE'?{unit_price:unitPrice(product,null,input.price_tier,'1',now)}:{})}
  }
  let frozen
  if(snapshot)frozen=validateSnapshot(snapshot,product)
  else{
    if(!baseUnit)fail(404,'Unidad base no encontrada')
    frozen=validateSnapshot({version:2,baseUnit:{id:baseUnit.id,code:baseUnit.code,name:baseUnit.name,label:baseUnit.label,decimals:product.quantity_decimals},presentation:presentation?{id:presentation.id,version:presentation.version,name:presentation.name,label:presentation.label,decimals:presentation.quantity_decimals}:null,factor:presentation?factorText(presentation.factor):'1',roundingDelta:'0'},product)
  }
  const precision=frozen.presentation?.decimals??frozen.baseUnit.decimals
  const qty=parseQuantity(input.qty,{decimals:precision}).toFixed()
  const converted=convertQuantity(qty,frozen.factor,{baseDecimals:frozen.baseUnit.decimals,commercialDecimals:precision,allowRounding:input.accept_rounding===true})
  frozen.roundingDelta=converted.roundingDelta
  const line={qty,base_qty:converted.baseQty,unit_metadata_version:2,unit_snapshot:frozen,item_name:product.name,item_kind:product.kind??'STANDARD',unit_label:frozen.presentation?.label??frozen.baseUnit.label,quantity_decimals:precision,unit_revision:product.unit_revision}
  if(operation==='SALE'){
    line.unit_price=frozenUnitPrice!=null?new Prisma.Decimal(String(frozenUnitPrice)).toFixed():unitPrice(product,presentation,input.price_tier,frozen.factor,now)
    line.line_total=lineTotal(qty,line.unit_price)
  }
  return line
}
module.exports={calculateUnitLine,unitPrice,validateSnapshot,publicPromotionSource}
