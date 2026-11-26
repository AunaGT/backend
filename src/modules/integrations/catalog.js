const {uuid,object,fail}=require('./credentials')
const {publicPromotionSource}=require('../inventory/units/calculation')
const {unitPrice}=require('../inventory/units/lines')
const unit=p=>({id:p.base_unit?.id||null,label:p.base_unit?.label||(p.kind==='SERVICE'?p.service_unit_label:'unidad')||'unidad',decimals:p.quantity_decimals||0})
const presentationSelect={id:true,name:true,label:true,factor:true,quantity_decimals:true,version:true}
const basics={id:true,name:true,description:true,brand:true,size:true,kind:true,quantity_decimals:true,unit_revision:true,unit_metadata_version:true,service_unit_label:true,image_url:true,barcode:true,company_id:true,category:{select:{id:true,name:true}},base_unit:{select:{id:true,label:true}},presentations:{where:{active:true,sale_enabled:true},select:presentationSelect,orderBy:{id:'asc'},take:100},barcodes:{where:{active:true,OR:[{presentation_id:null},{presentation:{active:true,sale_enabled:true}}]},select:{code:true,presentation_id:true},orderBy:{code:'asc'},take:100}}
function need(context,scope){if(!context.scopes.includes(scope))fail(403,'FORBIDDEN')}
function visible(context){return{company_id:context.companyId,deleted:false,available_for_sale:true,category:{company_id:context.companyId,deleted:false},...(context.servicesEnabled?{}:{kind:{not:'SERVICE'}})}}
function image(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash?u.href:null}catch{return null}}
function barcodes(p,context){
 const items=p.barcodes.filter(b=>b.presentation_id==null||context.unitsEnabled&&p.presentations.some(r=>r.id===b.presentation_id)).map(b=>({code:b.code,presentationId:b.presentation_id??null}))
 if(p.barcode&&!items.some(b=>b.code===p.barcode))items.unshift({code:p.barcode,presentationId:null})
 return items.slice(0,100)
}
function dto(p,context){return{id:p.id,name:p.name,description:p.description||null,brand:p.brand||null,size:p.size||null,kind:p.kind,category:p.category,unit:unit(p),...(context.unitsEnabled?{unitRevision:p.unit_revision??null,unitMetadataVersion:p.unit_metadata_version??1}:{}),imageUrl:image(p.image_url),barcodes:barcodes(p,context),presentations:context.unitsEnabled?p.presentations.map(r=>({id:r.id,name:r.name,label:r.label,version:r.version,factor:String(r.factor),decimals:r.quantity_decimals})):[]}}
function paging(query){
 const limit=Number(query.limit??25);if(!Number.isInteger(limit)||limit<1||limit>100)fail(400)
 let after
 if(query.cursor!==undefined){if(typeof query.cursor!=='string'||query.cursor.length>100||!/^[A-Za-z0-9_-]+$/.test(query.cursor))fail(400);after=Buffer.from(query.cursor,'base64url').toString();if(!uuid(after)&&!/^\d{1,10}$/.test(after))fail(400)}
 return{limit,after}
}
async function listProducts(db,context,query={}){
 need(context,'products.read');object(query,['limit','cursor','q','categoryId']);const {limit,after}=paging(query)
 if(after&&!uuid(after)||query.q!==undefined&&(typeof query.q!=='string'||query.q.length>100)||query.categoryId!==undefined&&!/^[1-9]\d{0,9}$/.test(query.categoryId))fail(400)
 const where={...visible(context),...(after?{id:{gt:after}}:{}),...(query.q?{name:{contains:query.q,mode:'insensitive'}}:{}),...(query.categoryId?{category_id:Number(query.categoryId)}:{})}
 const rows=await db.product.findMany({where,select:basics,orderBy:{id:'asc'},take:limit+1}),items=rows.slice(0,limit)
 return{items:items.map(p=>dto(p,context)),nextCursor:rows.length>limit?Buffer.from(items.at(-1).id).toString('base64url'):null}
}
async function getProduct(db,context,id){need(context,'products.read');if(!uuid(id))fail(404,'NOT_FOUND');const p=await db.product.findFirst({where:{...visible(context),id},select:basics});if(!p)fail(404,'NOT_FOUND');return dto(p,context)}
async function listCategories(db,context,query={}){
 need(context,'categories.read');object(query,['limit','cursor']);const {limit,after}=paging(query);if(after&&!/^[1-9]\d{0,9}$/.test(after))fail(400)
 const rows=await db.productCategory.findMany({where:{company_id:context.companyId,deleted:false,products:{some:visible(context)},...(after?{id:{gt:Number(after)}}:{})},select:{id:true,name:true,image_url:true},orderBy:{id:'asc'},take:limit+1}),items=rows.slice(0,limit)
 return{items:items.map(p=>({id:p.id,name:p.name,imageUrl:image(p.image_url)})),nextCursor:rows.length>limit?Buffer.from(String(items.at(-1).id)).toString('base64url'):null}
}
function batch(context,query){
 object(query,['productIds','branchId'])
 if(!uuid(query.branchId)||typeof query.productIds!=='string'||query.productIds.length>3700)fail(400)
 if(!context.branches.some(b=>b.id===query.branchId))fail(403,'FORBIDDEN')
 const raw=query.productIds.split(',');if(!raw.length||raw.length>100||raw.some(id=>!uuid(id)))fail(400)
 return [...new Set(raw)]
}
async function batchProducts(db,context,ids,select){const rows=await db.product.findMany({where:{...visible(context),id:{in:ids}},select});if(rows.length!==ids.length||rows.some(p=>p.company_id!==context.companyId))fail(404,'NOT_FOUND');return rows}
const priceSelect={...basics,price:true,price_promotion:true,promotion_valid_until:true,presentations:{...basics.presentations,select:{...presentationSelect,price:true,price_promotion:true,promotion_valid_until:true}}}
function priced(p,presentation,now){const factor=presentation?String(presentation.factor):'1',list=unitPrice(p,presentation,'LIST',factor,now),promo=publicPromotionSource(p,presentation,now);return{amount:list,promotion:promo?{amount:unitPrice(p,presentation,'PROMOTION',factor,now),validUntil:promo.promotion_valid_until?.toISOString()||null}:null}}
async function getPrices(db,context,query,now=new Date()){
 need(context,'prices.read');const ids=batch(context,query),rows=await batchProducts(db,context,ids,priceSelect)
 return{items:rows.map(p=>({productId:p.id,unit:unit(p),currency:context.currency,...priced(p,null,now),presentations:context.unitsEnabled?p.presentations.map(r=>({presentationId:r.id,label:r.label,...priced(p,r,now)})):[]})),asOf:now.toISOString()}
}
async function getAvailability(db,context,query,now=new Date()){
 need(context,'availability.read');const ids=batch(context,query),rows=await batchProducts(db,context,ids,{id:true,company_id:true,kind:true,quantity_decimals:true,service_unit_label:true,base_unit:{select:{id:true,label:true}},stock_assembled:true,kit_components:{select:{component_product:{select:{company_id:true,deleted:true}}}}})
 const physical=rows.filter(p=>p.kind!=='SERVICE'),safe=physical.filter(p=>p.kind!=='KIT'||(p.kit_components||[]).every(r=>r.component_product?.company_id===context.companyId&&!r.component_product.deleted))
 const availability=safe.length?await require('../../services/bomStock').getAvailabilityBatchWithKits(safe.map(p=>p.id),db,query.branchId,{companyId:context.companyId}):{}
 return{items:rows.map(p=>{const value=availability[p.id]?.available,unreliable=typeof value==='number'&&!Number.isSafeInteger(value),valid=p.kind!=='SERVICE'&&value!=null&&!unreliable;return{productId:p.id,unit:unit(p),status:p.kind==='SERVICE'?'NOT_APPLICABLE':valid?'AVAILABLE':'UNAVAILABLE',quantity:valid?String(value):null}}),asOf:now.toISOString()}
}
function listBranches(_db,context,query={}){object(query,[]);return{items:context.branches}}
module.exports={listProducts,getProduct,listCategories,listBranches,getPrices,getAvailability}
