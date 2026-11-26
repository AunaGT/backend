const {Prisma}=require('@prisma/client')
const {fail}=require('./credentials')
const {calculateUnitLine,publicPromotionSource}=require('../inventory/units/calculation')
const {advancedProduct,revision}=require('../inventory/units/access')
const {lineTotal,parseDecimal}=require('../../services/units/quantity')
const {publicProfileSelect,publicConditionsFromRow}=require('../appointments')
const publicPriceTier=(product,presentation,now)=>publicPromotionSource(product,presentation,now)?'PROMOTION':'LIST'
async function buildDraftLines(tx,context,type,items,now=new Date()){
 if(!['QUOTE','ORDER'].includes(type)||!Array.isArray(items)||!items.length||items.length>100)fail(400)
 const lines=[];let subtotal=parseDecimal('0',{allowZero:true})
 // Consistent order avoids product-lock inversion between concurrent requests.
 const products=new Map()
 for(const id of [...new Set(items.map(i=>i.productId))].sort()){
  await tx.$executeRaw`SELECT id FROM products WHERE id=${id}::uuid AND company_id=${context.companyId}::uuid FOR SHARE`
  const product=await tx.product.findFirst({where:{id,company_id:context.companyId,deleted:false,available_for_sale:true,category:{company_id:context.companyId,deleted:false}},select:{id:true,company_id:true,name:true,kind:true,available_for_sale:true,deleted:true,price:true,price_promotion:true,promotion_valid_until:true,base_unit_id:true,quantity_decimals:true,unit_revision:true,unit_metadata_version:true,service_unit_label:true,default_sale_presentation_id:true,service_schedule_profile:{select:publicProfileSelect}}})
  if(!product||product.company_id!==context.companyId||product.kind==='SERVICE'&&!context.servicesEnabled)fail(404,'NOT_FOUND')
  products.set(id,product)
 }
 for(const [index,item] of items.entries()){
  const product=products.get(item.productId);let base=null,presentation=null
  if(advancedProduct(product)){
   if(!context.unitsEnabled)fail(409,'UNIT_REVIEW_REQUIRED')
   try{revision(product,item.unitRevision)}catch(e){if(e.code==='UNIT_REVISION_CONFLICT')fail(409,'UNIT_REVIEW_REQUIRED');throw e}
   base=await tx.measureUnit.findFirst({where:{id:product.base_unit_id,company_id:context.companyId}})
   const id=item.presentationId===undefined?product.default_sale_presentation_id:item.presentationId
   if(id){presentation=await tx.productPresentation.findFirst({where:{id,product_id:product.id,company_id:context.companyId,active:true,sale_enabled:true}});if(!presentation)fail(404,'NOT_FOUND')}
  }
  let line
  try{line=calculateUnitLine(product,{baseUnit:base,presentation,operation:'SALE',now},{qty:item.quantity,presentation_id:item.presentationId,unit_revision:item.unitRevision,price_tier:publicPriceTier(product,presentation,now)})}
  catch(e){if(e.code==='QUANTITY_ROUNDING_REQUIRED'||e.message==='La unidad base es indivisible')fail(409,'UNIT_REVIEW_REQUIRED');if(e.status===400||e.status===409)fail(e.status,'INVALID_INPUT');throw e}
  const total=line.line_total??lineTotal(line.qty,line.unit_price)
  subtotal=subtotal.add(total);if(subtotal.gt('9999999999.99'))fail(400)
  const {unit_revision,...snapshot}=line
  lines.push({...snapshot,product_id:product.id,line_total:total,qty_fulfilled:'0',qty_invoiced:'0',base_fulfilled:'0',base_invoiced:'0',sort_order:index,service_schedule_snapshot:product.kind==='SERVICE'?(publicConditionsFromRow(product.service_schedule_profile)??Prisma.DbNull):Prisma.DbNull})
 }
 return{lines,subtotal:subtotal.toFixed(2),total:subtotal.toFixed(2)}
}
module.exports={buildDraftLines,publicPriceTier}
