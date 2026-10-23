const {hasPerm}=require('../../middlewares/tenant')
const {assertServicesEnabled}=require('../../services/catalogItemRules')
const {extendProductDTO}=require('./units')
const fail=(status,message)=>{throw Object.assign(Error(message),{status})}
const fields=['id','name','brand','size','barcode','image_url','kind','available_for_sale','category_id','base_unit_id','unit_metadata_version','quantity_decimals','unit_revision','default_sale_presentation_id','price','price_wholesale','price_promotion','promotion_valid_until','stock','min_stock','service_unit_label']
const select={...Object.fromEntries(fields.map(key=>[key,true])),category:{select:{id:true,name:true}}}
const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]))
function object(raw,keys){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!keys.includes(key)))fail(400,'Solicitud de catálogo inválida')}
function text(raw,max=100){if(typeof raw!=='string'||raw.length>max||/[\x00-\x1f\x7f]/.test(raw))fail(400,'Filtro de catálogo inválido');return raw.trim()}
function integer(raw,fallback,max=Number.MAX_SAFE_INTEGER){const value=raw===undefined?fallback:Number(raw);if(raw!==undefined&&(typeof raw!=='string'&&typeof raw!=='number'||!/^\d+$/.test(String(raw)))||!Number.isSafeInteger(value)||value<1||value>max)fail(400,'Paginación inválida');return value}
function scopeCheck(scope){if(!scope.companyId)fail(403,'Empresa requerida');if(!scope.branchId||scope.branchId==='all')fail(400,'Selecciona una sucursal');if(!hasPerm(scope.user,'sales.create'))fail(403,'Sin permiso para vender')}
async function whereFor(db,scope,raw,{search=true,category=false}={}){
 scopeCheck(scope)
 const catalog=raw.catalog_type??'goods';if(!['goods','all'].includes(catalog))fail(400,'Tipo de catálogo inválido')
 const term=search&&raw.search!==undefined?text(raw.search):'',categoryName=category&&raw.category!==undefined?text(raw.category):''
 if(catalog==='all')await assertServicesEnabled(db,scope.companyId)
 const physical={kind:{not:'SERVICE'},branch_stocks:{some:{branch_id:scope.branchId}}}
 const where={company_id:scope.companyId,deleted:false,available_for_sale:true,...(catalog==='all'?{AND:[{OR:[{kind:'SERVICE'},physical]}]}:physical)}
 if(term)where.OR=['name','brand','barcode'].map(key=>({[key]:{contains:term,mode:'insensitive'}}))
 if(categoryName&&!term)where.category={name:{equals:categoryName,mode:'insensitive'}}
 return where
}
async function itemsDTO(db,scope,rows){
 const ids=rows.filter(row=>row.kind!=='SERVICE').map(row=>row.id)
 const stocks=ids.length?await db.productStock.findMany({where:{branch_id:scope.branchId,product_id:{in:ids}},select:{product_id:true,stock:true,min_stock:true}}):[]
 const byId=new Map(stocks.map(row=>[row.product_id,row]))
 const overlaid=rows.map(row=>{const stock=byId.get(row.id);return{...row,stock:row.kind==='SERVICE'?0:stock?.stock??0,min_stock:row.kind==='SERVICE'?0:stock?.min_stock??0,in_branch:row.kind==='SERVICE'||!!stock}})
 return(await extendProductDTO(db,{companyId:scope.companyId},overlaid)).map(row=>({...pick(row,[...fields,'category','in_branch','base_unit','default_purchase_presentation_id']),...(row.presentations?{presentations:row.presentations.map(p=>pick(p,['id','version','name','label','factor','quantity_decimals','active','sale_enabled','purchase_enabled','price','price_wholesale','price_promotion','promotion_valid_until','prices','barcode']))}:{})}))
}
async function listPosCatalog(db,scope,raw={}){
 object(raw,['page','pageSize','search','category','catalog_type'])
 const wanted=integer(raw.page,1),pageSize=integer(raw.pageSize,20,100),where=await whereFor(db,scope,raw,{category:true})
 const totalItems=await db.product.count({where}),totalPages=Math.max(1,Math.ceil(totalItems/pageSize)),page=Math.min(wanted,totalPages)
 const rows=await db.product.findMany({where,select,orderBy:[{name:'asc'},{id:'asc'}],skip:(page-1)*pageSize,take:pageSize})
 return{items:await itemsDTO(db,scope,rows),page,pageSize,totalPages,totalItems,nextPage:page<totalPages?page+1:null,prevPage:page>1?page-1:null}
}
async function listPosCategories(db,scope,raw={}){
 object(raw,['search','catalog_type'])
 const where=await whereFor(db,scope,raw),groups=await db.product.groupBy({by:['category_id'],where,_count:{_all:true}})
 const categories=groups.length?await db.productCategory.findMany({where:{company_id:scope.companyId,id:{in:groups.map(g=>g.category_id)}},select:{id:true,name:true,image_url:true}}):[]
 const byId=new Map(categories.map(c=>[c.id,c])),items=groups.map(g=>({name:byId.get(g.category_id)?.name??'Sin categoría',count:g._count._all,image_url:byId.get(g.category_id)?.image_url??null})).sort((a,b)=>a.name.localeCompare(b.name,'es'))
 return{items,totalItems:items.reduce((sum,item)=>sum+item.count,0)}
}
async function posCatalogItems(db,scope,raw){
 object(raw,['ids','catalog_type'])
 if(!Array.isArray(raw.ids)||raw.ids.length<1||raw.ids.length>200||raw.ids.some(id=>typeof id!=='string'||! /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)))fail(400,'Selecciona entre1 y200 productos válidos')
 const ids=[...new Set(raw.ids.map(id=>id.toLowerCase()))].sort(),where=await whereFor(db,scope,raw,{search:false})
 const rows=await db.product.findMany({where:{...where,id:{in:ids}},select,orderBy:[{id:'asc'}],take:ids.length}),items=await itemsDTO(db,scope,rows),found=new Set(items.map(p=>p.id))
 return{items,missingIds:ids.filter(id=>!found.has(id))}
}
async function resolvePosCode(db,scope,raw){
 object(raw,['code','catalog_type']);const code=text(raw.code);if(!code)fail(400,'Ingresa un código')
 const where=await whereFor(db,scope,raw,{search:false}),rows=await db.product.findMany({where:{...where,barcode:code},select,take:2,orderBy:[{id:'asc'}]})
 if(rows.length>1)fail(409,'El código corresponde a varios productos. Revisa el catálogo.')
 return{item:(await itemsDTO(db,scope,rows))[0]??null}
}
module.exports={listPosCatalog,listPosCategories,posCatalogItems,resolvePosCode,catalogItemsDTO:itemsDTO}
