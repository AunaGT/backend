const {parseQuantity}=require('../../../services/units/quantity')
const {UNITS_READY,advancedProduct,fail,authorize,unitsEnabled,assertEnabled,lockCompany,lockProduct,revision,bumpRevision,objectInput,text,decimals,factorText}=require('./access')
const CONFIG_KEYS=['base_unit_id','quantity_decimals','default_purchase_presentation_id','default_sale_presentation_id']
const {assertProductMigrationReady}=require('./migrationReadiness')
async function listUnits(db,scope,{includeArchived=false}={}) {
  authorize(scope,['products.view','products.create','products.edit','sales.create','products.register_incoming'])
  await assertEnabled(db,scope)
  const rows=await db.measureUnit.findMany({where:{company_id:scope.companyId,...(includeArchived?{}:{active:true})},orderBy:[{family:'asc'},{name:'asc'}]})
  return rows.map(row=>({...row,factor:factorText(row.factor)}))
}
async function saveUnit(tx,scope,input,id=null) {
  authorize(scope,['settings.manage'],true);await assertEnabled(tx,scope)
  objectInput(input,['code','family','name','label','factor','quantity_decimals','active'])
  await lockCompany(tx,scope.companyId)
  await assertEnabled(tx,scope)
  const old=id?await tx.measureUnit.findFirst({where:{id,company_id:scope.companyId}}):null
  if(id&&!old)fail(404,'Unidad no encontrada')
  const data={}
  for(const [key,max] of [['code',40],['family',50],['name',100],['label',50]])if(input[key]!==undefined)data[key]=text(input[key],key,max)
  if(data.code)data.code=data.code.toUpperCase()
  if(data.family)data.family=data.family.toUpperCase()
  if(input.factor!==undefined)data.factor=parseQuantity(input.factor,{decimals:12,max:'99999999.999999999999'}).toFixed()
  if(input.quantity_decimals!==undefined)data.quantity_decimals=decimals(input.quantity_decimals)
  if(input.active!==undefined){if(typeof input.active!=='boolean')fail(400,'Estado inválido');data.active=input.active}
  if(!old){for(const key of ['code','family','name','label','factor','quantity_decimals'])if(data[key]===undefined)fail(400,`Falta ${key}`)}
  if(old&&['code','family','factor','quantity_decimals'].some(k=>data[k]!==undefined&&(k==='factor'?factorText(data[k])!==factorText(old[k]):String(data[k])!==String(old[k])))){
    if(old.is_standard||await tx.product.findFirst({where:{company_id:scope.companyId,base_unit_id:id}})||await tx.productPresentation.findFirst({where:{company_id:scope.companyId,measure_unit_id:id}}))fail(409,'Una unidad estándar o utilizada conserva su definición; crea otra unidad')
  }
  try{return old?await tx.measureUnit.update({where:{id:old.id},data}):await tx.measureUnit.create({data:{company_id:scope.companyId,...data,is_standard:false}})}catch(e){if(e.code==='P2002')fail(409,'El código de unidad ya existe');throw e}
}
async function hasProductHistory(tx,productId) {
  for(const model of ['saleItem','commercialDocumentLine','purchaseLog','incomingMerchandiseItem','stockMovement','productLot','stockTransferLine','inventoryCountLine','returnItem','returnReplacementItem','orderDeliveryLine','stockReservation','appointmentEngagementLine','appointmentSession']) {
    if(await tx[model].findFirst({where:{product_id:productId},select:{id:true}}))return true
  }
  if(await tx.productBomLine.findFirst({where:{OR:[{kit_product_id:productId},{component_product_id:productId}]},select:{id:true}}))return true
  for(const model of ['productStock','productStockLocation'])if(await tx[model].findFirst({where:{product_id:productId,stock:{not:0}},select:{id:true}}))return true
  return false
}
async function productBaseLocked(db,scope,product){
  if(product.company_id!==scope.companyId)fail(404,'Producto no encontrado')
  return !!(await db.productPresentation.findFirst({where:{company_id:scope.companyId,product_id:product.id},select:{id:true}}))||await hasProductHistory(db,product.id)
}
async function configureProduct(tx,scope,id,input) {
  authorize(scope,['products.edit','products.create'],true);await assertEnabled(tx,scope)
  objectInput(input,[...CONFIG_KEYS,'unit_revision'])
  await lockCompany(tx,scope.companyId)
  await assertEnabled(tx,scope)
  const product=await lockProduct(tx,scope,id);revision(product,input.unit_revision)
  await assertProductMigrationReady(tx,product)
  const baseId=input.base_unit_id===undefined?product.base_unit_id:input.base_unit_id
  if(!baseId)fail(400,'Selecciona una unidad base')
  const base=await tx.measureUnit.findFirst({where:{id:baseId,company_id:scope.companyId,...(baseId===product.base_unit_id?{}:{active:true})}})
  if(!base)fail(404,'Unidad base no encontrada')
  const precision=input.quantity_decimals??(product.base_unit_id?product.quantity_decimals:base.quantity_decimals)
  decimals(precision,product.kind==='SERVICE'?4:product.kind==='KIT'?0:6)
  if(precision>base.quantity_decimals)fail(400,'La precisión excede la unidad base')
  const changed=baseId!==product.base_unit_id||precision!==product.quantity_decimals
  if(changed){
    if(await hasProductHistory(tx,id))fail(409,'Un producto con historia o existencias conserva su unidad base y precisión','BASE_UNIT_IMMUTABLE')
    if(await tx.productPresentation.findFirst({where:{company_id:scope.companyId,product_id:id}}))fail(409,'Un producto con presentaciones conserva su unidad base y precisión','BASE_UNIT_IMMUTABLE')
  }
  const data={base_unit_id:baseId,quantity_decimals:precision,unit_metadata_version:2}
  for(const [key,enabled] of [['default_purchase_presentation_id','purchase_enabled'],['default_sale_presentation_id','sale_enabled']])if(input[key]!==undefined){
    if(input[key]!==null){const row=await tx.productPresentation.findFirst({where:{id:input[key],company_id:scope.companyId,product_id:id}});if(!row)fail(404,'Presentación no encontrada');if(!row.active||!row[enabled])fail(400,'La presentación no está habilitada para esa operación')}
    data[key]=input[key]
  }
  return bumpRevision(tx,product,data)
}
async function assertUnitsSettingChange(tx,companyId,value) {
  if(!['true','false'].includes(String(value).toLowerCase()))fail(400,'inventory_units_enabled debe ser true o false')
  if(String(value).toLowerCase()==='true') { if(!UNITS_READY)fail(409,'Las unidades y presentaciones aún requieren la activación coordinada','UNITS_NOT_READY');await lockCompany(tx,companyId);return }
  await lockCompany(tx,companyId)
  if(!await unitsEnabled(tx,companyId))return
  if(await tx.product.findFirst({where:{company_id:companyId,unit_metadata_version:2},select:{id:true}}))fail(409,'La empresa ya tiene productos con unidades; no se puede desactivar','UNITS_IN_USE')
  for(const model of ['sale','commercialDocument','incomingMerchandise','return'])if(await tx[model].findFirst({where:{...(model==='return'?{sale:{branch:{company_id:companyId}}}:{branch:{company_id:companyId}}),unit_metadata_version:2},select:{id:true}}))fail(409,'La empresa ya tiene operaciones con unidades; no se puede desactivar','UNITS_IN_USE')
}
async function extendProductDTO(db,scope,products) {
  if(!products.some(p=>p.base_unit_id))return products
  const enabled=await unitsEnabled(db,scope.companyId)
  const ids=products.filter(p=>p.base_unit_id).map(p=>p.id)
  const [bases,rows,codes]=await Promise.all([
    db.measureUnit.findMany({where:{company_id:scope.companyId,id:{in:products.map(p=>p.base_unit_id).filter(Boolean)}}}),
    enabled?db.productPresentation.findMany({where:{company_id:scope.companyId,product_id:{in:ids},active:true},orderBy:{name:'asc'}}):[],
    enabled?db.productBarcode.findMany({where:{company_id:scope.companyId,product_id:{in:ids},active:true}}):[],
  ])
  return products.map(p=>{if(!p.base_unit_id)return p;const base=bases.find(b=>b.id===p.base_unit_id);const exact=Object.fromEntries(['stock','min_stock','price','price_wholesale','price_promotion','cost'].filter(key=>p[key]!=null).map(key=>[key,typeof p[key]==='object'&&typeof p[key].toFixed==='function'?p[key].toFixed():String(p[key])]));return {...p,...exact,base_unit:base?{...base,factor:factorText(base.factor)}:null,presentations:rows.filter(r=>r.product_id===p.id).map(r=>presentationDTO(r,codes)),default_purchase_presentation_id:p.default_purchase_presentation_id??null,default_sale_presentation_id:p.default_sale_presentation_id??null}})
}
function presentationDTO(row,codes=[]) {
  return {...row,factor:factorText(row.factor),price:row.price==null?null:String(row.price),price_wholesale:row.price_wholesale==null?null:String(row.price_wholesale),price_promotion:row.price_promotion==null?null:String(row.price_promotion),prices:{LIST:row.price==null?null:String(row.price),WHOLESALE:row.price_wholesale==null?null:String(row.price_wholesale),PROMOTION:row.price_promotion==null?null:String(row.price_promotion)},barcode:codes.find(b=>b.presentation_id===row.id&&b.active)?.code??null}
}
module.exports={CONFIG_KEYS,listUnits,saveUnit,hasProductHistory,productBaseLocked,configureProduct,assertUnitsSettingChange,extendProductDTO,presentationDTO}
