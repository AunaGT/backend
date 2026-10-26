const {calculateUnitLine}=require('../units/calculation')
const {parseQuantity}=require('../../../services/units/quantity')
const {assertServicesEnabled}=require('../../../services/catalogItemRules')
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})}
async function validateReferences(tx,scope,definition,{lock=false}={}) {
  const refs=definition.variants.flatMap(variant=>[
    ...variant.components.map(component=>({...component,checkQuantity:component.quantity})),
    ...variant.choices.flatMap(choice=>choice.options.map(option=>({...option,checkQuantity:choice.totalQuantity}))),
  ]).filter(ref=>ref.productId)
  const ids=[...new Set(refs.map(ref=>ref.productId))].sort()
  if(ids.length>1000)fail(400,'INVALID_PACKAGE','El paquete contiene demasiados productos diferentes')
  if(lock&&ids.length)await tx.$executeRaw`SELECT id FROM products WHERE company_id=${scope.companyId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`
  const products=ids.length?await tx.product.findMany({where:{id:{in:ids},company_id:scope.companyId,deleted:false,available_for_sale:true,category:{company_id:scope.companyId,deleted:false}},
    select:{id:true,company_id:true,name:true,kind:true,quantity_decimals:true,service_unit_label:true,unit_revision:true,unit_metadata_version:true,base_unit_id:true,
      base_unit:{select:{id:true,code:true,name:true,label:true,active:true}},presentations:{where:{active:true,sale_enabled:true},select:{id:true,name:true,label:true,version:true,factor:true,quantity_decimals:true,active:true,sale_enabled:true}}}}):[]
  if(products.length!==ids.length)fail(404,'NOT_FOUND','Un producto del paquete no está disponible')
  const byId=new Map(products.map(product=>[product.id,product])),units=new Map()
  if(products.some(product=>product.kind==='SERVICE'))await assertServicesEnabled(tx,scope.companyId)
  for(const ref of refs){
    const product=byId.get(ref.productId)
    if(ref.unitRevision!=null&&ref.unitRevision!==(product.unit_revision??1))fail(409,'UNIT_REVISION_CONFLICT','La unidad del producto cambió; revisa el paquete')
    const advanced=product.unit_metadata_version===2
    const presentation=ref.presentationId?product.presentations.find(item=>item.id===ref.presentationId):null
    if(ref.presentationId&&(!advanced||!presentation))fail(404,'NOT_FOUND','Una presentación del paquete no está disponible')
    if(advanced&&(!product.base_unit||!product.base_unit.active))fail(409,'UNIT_REVISION_CONFLICT','La unidad base ya no está disponible')
    if(ref.checkQuantity!=null)calculateUnitLine(product,{baseUnit:product.base_unit,presentation,operation:'PURCHASE'},
      {qty:ref.checkQuantity,presentation_id:ref.presentationId,unit_revision:ref.unitRevision,accept_rounding:false})
    const kind=product.kind==='SERVICE'?'SERVICE':'PHYSICAL',precision=presentation?.quantity_decimals??product.quantity_decimals
    const base=advanced?product.base_unit.id:product.kind==='SERVICE'?product.service_unit_label:'unidad'
    const factor=presentation?parseQuantity(presentation.factor,{decimals:12,max:'99999999.999999999999'}).toFixed():'1'
    units.set(ref.id,JSON.stringify([kind,base,factor,precision]))
  }
  for(const variant of definition.variants)for(const choice of variant.choices){
    const identities=choice.options.map(option=>units.get(option.id)).filter(Boolean)
    if(new Set(identities).size>1)fail(400,'PACKAGE_UNITS_MISMATCH','Las opciones del grupo deben compartir unidad, factor y precisión')
  }
  return byId
}
module.exports={validateReferences}
