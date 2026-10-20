const Units=require('../../modules/inventory/units')
const {D}=require('./commercial')
const {parseQuantity}=require('./quantity')
const countUnit={id:null,code:'UNIT',family:'COUNT',factor:'1'}
const fail=message=>{throw Object.assign(new Error(message),{status:400})}

async function resolvePromotionReference(tx,companyId,payload,typeName){
  const input=payload.quantity_reference
  if(input==null)return null
  if(!await Units.unitsEnabled(tx,companyId))fail('Las unidades y presentaciones están desactivadas')
  if(!['BUY_X_GET_Y','MIN_QTY_DISCOUNT','FREE_GIFT','COMBO_DISCOUNT'].includes(typeName))fail('Esta promoción no admite una referencia de cantidad')
  if(typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['trigger_unit_id','gift_unit_id'].includes(key))||typeof input.trigger_unit_id!=='string')fail('Referencia de cantidad inválida')
  const load=async id=>{
    if(typeof id!=='string'||!id.trim())fail('Unidad de referencia inválida')
    const unit=await tx.measureUnit.findFirst({where:{id,company_id:companyId,active:true}})
    if(!unit)fail('Unidad de referencia no encontrada en esta empresa')
    return{id:unit.id,code:unit.code,family:unit.family,factor:parseQuantity(unit.factor,{decimals:12,max:'99999999.999999999999'}).toFixed()}
  }
  const trigger=await load(input.trigger_unit_id),gift=input.gift_unit_id?await load(input.gift_unit_id):null
  if(typeName==='BUY_X_GET_Y'&&gift&&gift.family!==trigger.family)fail('La unidad del regalo debe pertenecer a la familia del producto descontado')
  if(trigger.family!=='COUNT'&&(payload.applies_to_all||(payload.category_ids||[]).length))fail('La referencia medida requiere productos concretos de una misma familia')
  const triggerIds=[...new Set([...(payload.product_ids||[]),payload.trigger_product_id].filter(Boolean))]
  if(trigger.family!=='COUNT'&&!triggerIds.length)fail('Selecciona los productos de la referencia medida')
  const ids=[...new Set([...triggerIds,payload.target_product_id].filter(Boolean))]
  const products=ids.length?await tx.product.findMany({where:{id:{in:ids},company_id:companyId,deleted:false},include:{base_unit:true}}):[]
  if(products.length!==ids.length)fail('Producto no encontrado en esta empresa')
  for(const product of products){
    const base=product.base_unit||countUnit
    const reference=product.id===payload.target_product_id?gift||countUnit:trigger
    if(product.kind==='SERVICE'||base.family!==reference.family||(triggerIds.includes(product.id)&&base.family!==trigger.family))fail('La unidad de referencia no corresponde a la familia del producto')
  }
  for(const key of ['buy_quantity','get_quantity','min_quantity'])if(payload[key]!=null&&payload[key]!=='')parseQuantity(String(payload[key]),{decimals:6,allowZero:key==='get_quantity'})
  return{version:1,trigger,gift}
}

async function withPromotionBaseUnits(tx,items,companyId){
  const products=await tx.product.findMany({where:{id:{in:[...new Set(items.map(item=>item.product_id))]},company_id:companyId},include:{base_unit:true}})
  const byId=new Map(products.map(product=>[product.id,product]))
  return items.map(item=>{const product=byId.get(item.product_id);if(!product)fail('Producto no encontrado en esta empresa');const base=product.base_unit;
    return{...item,category_id:product.category_id,promotion_base_unit:base?{id:base.id,code:base.code,family:base.family,factor:D(base.factor).toFixed()}:countUnit}})
}
module.exports={resolvePromotionReference,withPromotionBaseUnits,countUnit}
