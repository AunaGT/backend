const {assertAccess,authorizedScope,productWhere,has,error}=require('./access')
const {parseLayoutInput,parseLabelDesign,parsePaperSettings,createLabelTemplate,createShelfLabelTemplate,defaultPaper,fail}=require('./validation')
const Units=require('../units'),{resolveLabelSelection}=require('./unitSelection')
const KEY='inventory.barcode_label_layout'
const {setSettingsActor}=require('../../../services/settingsRevision')
const keyFor=purpose=>purpose==='shelf'?'inventory.shelf_price_label_layout':KEY
function layoutFromRow(row,purpose='barcode'){
  if(!row)return{revision:0,design:purpose==='shelf'?createShelfLabelTemplate():createLabelTemplate(),defaultPaper:defaultPaper()}
  try{const v=JSON.parse(row.value);if((v.design?.purpose==='shelf')!==(purpose==='shelf'))throw Error();if(!Number.isSafeInteger(v.revision)||v.revision<1)throw Error();return{revision:v.revision,design:parseLabelDesign(v.design),defaultPaper:parsePaperSettings(v.defaultPaper)}}catch{error(409,'LAYOUT_INVALID','El diseño guardado no es válido; solicita revisar su configuración')}
}
async function readBarcodeLayout(db,scope,purpose='barcode'){
  await assertAccess(db,scope)
  return{...layoutFromRow(await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:keyFor(purpose)}}}),purpose),capabilities:{canAssign:purpose!=='shelf'&&has(scope,'products.edit'),canSaveLayout:has(scope,'settings.manage')}}
}
async function saveBarcodeLayout(db,scope,raw,purpose='barcode'){
  const input=parseLayoutInput(raw)
  if((input.design.purpose==='shelf')!==(purpose==='shelf'))fail('purpose')
  return db.$transaction(async tx=>{
    await assertAccess(tx,scope,{save:true})
    await setSettingsActor(tx,{actorId:scope.userId,source:purpose==='shelf'?'shelf-price-design':'barcode-design'})
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`barcode-labels:${scope.companyId}`},0))`
    const where={company_id_key:{company_id:scope.companyId,key:keyFor(purpose)}},current=layoutFromRow(await tx.systemSetting.findUnique({where}),purpose)
    if(current.revision!==input.expectedRevision)error(409,'LAYOUT_CONFLICT','Otra persona guardó un diseño. Recarga antes de reemplazarlo')
    const result={revision:current.revision+1,design:input.design,defaultPaper:input.defaultPaper},value=JSON.stringify(result)
    await tx.systemSetting.upsert({where,create:{company_id:scope.companyId,key:keyFor(purpose),value,type:'json'},update:{value,type:'json'}})
    return{...result,capabilities:{canAssign:has(scope,'products.edit'),canSaveLayout:true}}
  },{timeout:10000,maxWait:5000})
}
async function listBarcodeCandidates(db,scope,q={},purpose='barcode'){
  await assertAccess(db,scope)
  const validId=(value,key)=>{if(value!==undefined&&!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(String(value)))fail(key);return value}
  const filter=await authorizedScope(db,scope,{branchId:validId(q.branch_id,'branch_id'),warehouseId:validId(q.warehouse_id,'warehouse_id'),locationId:validId(q.location_id,'location_id'),inBranch:['true','1'].includes(q.in_branch)})
  const page=Number(q.page||1),pageSize=Number(q.pageSize||10)
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)fail('page')
  const where=productWhere(scope,filter)
  if(q.ids){const ids=String(q.ids).split(',');if(ids.length>100)fail('ids');ids.forEach(id=>validId(id,'ids'));where.id={in:ids}}
  if(q.search){if(typeof q.search!=='string'||q.search.length>150)fail('search');where.OR=['name','brand','barcode'].map(k=>({[k]:{contains:q.search,mode:'insensitive'}}))}
  if(q.category&&q.category!=='all')where.category={name:{equals:String(q.category),mode:'insensitive'}}
  if(q.supplier)where.supplier_id=validId(q.supplier,'supplier')
  const [totalItems,rows]=await Promise.all([db.product.count({where}),db.product.findMany({where,select:{id:true,name:true,barcode:true,price:true,brand:true,size:true,...(purpose==='shelf'?{price_wholesale:true,price_promotion:true,promotion_valid_until:true}:{})},orderBy:[{name:'asc'},{id:'asc'}],skip:(page-1)*pageSize,take:pageSize})])
  const enabled=await Units.unitsEnabled(db,scope.companyId),options=new Map()
  if(enabled)for(const p of rows){
    const config=await db.product.findFirst({where:{id:p.id,company_id:scope.companyId,deleted:false},select:{base_unit_id:true,unit_metadata_version:true,unit_revision:true}})
    if(!Units.advancedProduct(config))continue
    const presentations=await db.productPresentation.findMany({where:{company_id:scope.companyId,product_id:p.id,active:true,sale_enabled:true},orderBy:{name:'asc'}}),selected=[]
    for(const presentation_id of [null,...presentations.map(p=>p.id)]){const option=await resolveLabelSelection(db,scope,p,{presentation_id,unit_revision:config.unit_revision},true);selected.push({...option,...(purpose==='shelf'?{shelfPrices:require('./shelfPrices').shelfPricesForProduct(option,['LIST','WHOLESALE','PROMOTION']).prices}:{})})}
    options.set(p.id,{unit_revision:config.unit_revision,unitOptions:selected})
  }
  return{items:rows.map(p=>({...p,...options.get(p.id),price:p.price.toString(),barcode:p.barcode?.trim()?p.barcode:null,...(purpose==='shelf'?{shelfPrices:require('./shelfPrices').shelfPricesForProduct(p,['LIST','WHOLESALE','PROMOTION']).prices,priceWholesale:p.price_wholesale?.toString()||null,pricePromotion:p.price_promotion?.toString()||null,promotionValidUntil:p.promotion_valid_until?new Date(p.promotion_valid_until).toISOString():null}:{})})),totalItems,totalPages:Math.max(1,Math.ceil(totalItems/pageSize)),page}
}
module.exports={readBarcodeLayout,saveBarcodeLayout,listBarcodeCandidates}
