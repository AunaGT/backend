const {parseQuantity}=require('../../../services/units/quantity')
const {fail,advancedProduct,authorize,assertEnabled,lockCompany,lockProduct,scopedProduct,revision,bumpRevision,objectInput,text,decimals,factorText}=require('./access')
const {presentationDTO}=require('./catalog')
const {normalizeCode,reserveCode}=require('./barcodes')
const {assertProductMigrationReady}=require('./migrationReadiness')
async function listPresentations(db,scope,id,{includeArchived=false}={}) {
  authorize(scope,['products.view','products.create','products.edit','sales.create','products.register_incoming'])
  await assertEnabled(db,scope);await scopedProduct(db,scope,id)
  const [rows,codes]=await Promise.all([db.productPresentation.findMany({where:{company_id:scope.companyId,product_id:id,...(includeArchived?{}:{active:true})},orderBy:[{name:'asc'},{version:'desc'}]}),db.productBarcode.findMany({where:{company_id:scope.companyId,product_id:id,active:true}})])
  return rows.map(p=>presentationDTO(p,codes))
}
async function savePresentation(tx,scope,productId,input,id=null) {
  authorize(scope,['products.edit','products.create'],true);await assertEnabled(tx,scope)
  objectInput(input,['unit_revision','name','label','factor','measure_unit_id','quantity_decimals','purchase_enabled','sale_enabled','active','prices','promotion_valid_until','barcode'])
  await lockCompany(tx,scope.companyId)
  await assertEnabled(tx,scope)
  const product=await lockProduct(tx,scope,productId);revision(product,input.unit_revision)
  if(!product.base_unit_id)fail(400,'Configura primero la unidad base del producto')
  advancedProduct(product)
  await assertProductMigrationReady(tx,product)
  const old=id?await tx.productPresentation.findFirst({where:{id,company_id:scope.companyId,product_id:productId}}):null
  if(id&&!old)fail(404,'Presentación no encontrada')
  if(old&&!old.active)fail(409,'La presentación está archivada; utiliza su versión vigente')
  const data={}
  for(const [key,max] of [['name',100],['label',50]])if(input[key]!==undefined)data[key]=text(input[key],key,max)
  for(const key of ['purchase_enabled','sale_enabled','active'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')fail(400,'Estado de presentación inválido');data[key]=input[key]}
  if(input.quantity_decimals!==undefined)data.quantity_decimals=decimals(input.quantity_decimals,product.kind==='SERVICE'?4:6)
  if(input.measure_unit_id!==undefined)data.measure_unit_id=input.measure_unit_id
  const measureId=data.measure_unit_id===undefined?old?.measure_unit_id:data.measure_unit_id
  if(measureId&&(!old||input.measure_unit_id!==undefined||input.factor!==undefined)){
    if(input.factor!==undefined)fail(400,'La unidad de medida determina el factor')
    const [base,measure]=await Promise.all([tx.measureUnit.findFirst({where:{id:product.base_unit_id,company_id:scope.companyId}}),tx.measureUnit.findFirst({where:{id:measureId,company_id:scope.companyId,active:true}})])
    if(!measure||!base)fail(404,'Unidad de medida no encontrada')
    if(base.family!==measure.family)fail(400,'La unidad de la presentación debe pertenecer a la misma familia que la base')
    const factor=parseQuantity(measure.factor,{decimals:12,max:'99999999.999999999999'}).div(String(base.factor))
    if(factor.decimalPlaces()>12)fail(400,'La conversión requiere más de doce decimales; elige otra unidad base')
    data.factor=parseQuantity(factor,{decimals:12,max:'99999999.999999999999'}).toFixed()
  }else if(input.factor!==undefined)data.factor=parseQuantity(input.factor,{decimals:12,max:'99999999.999999999999'}).toFixed()
  if(input.prices!==undefined){
    objectInput(input.prices,['LIST','WHOLESALE','PROMOTION'])
    for(const [tier,key] of [['LIST','price'],['WHOLESALE','price_wholesale'],['PROMOTION','price_promotion']])if(input.prices[tier]!==undefined)data[key]=input.prices[tier]===null?null:parseQuantity(input.prices[tier],{decimals:6,allowZero:true,max:'9999999999.99'}).toFixed()
  }
  if(input.promotion_valid_until!==undefined){data.promotion_valid_until=input.promotion_valid_until===null?null:new Date(input.promotion_valid_until);if(data.promotion_valid_until&&Number.isNaN(data.promotion_valid_until.getTime()))fail(400,'Fecha de promoción inválida')}
  const barcode=input.barcode===undefined?undefined:input.barcode===null?null:normalizeCode(input.barcode)
  if(!old)for(const key of ['name','label','factor','quantity_decimals'])if(data[key]===undefined)fail(400,`Falta ${key}`)
  if(old&&Object.keys(data).length===1&&data.active===false&&barcode===undefined){
    const archived=await tx.productPresentation.update({where:{id:old.id},data:{active:false}})
    await tx.productBarcode.updateMany({where:{company_id:scope.companyId,product_id:productId,presentation_id:old.id},data:{active:false}})
    const defaults={};for(const key of ['default_purchase_presentation_id','default_sale_presentation_id'])if(product[key]===old.id)defaults[key]=null
    await bumpRevision(tx,product,defaults);return archived
  }
  const inherited=old?Object.fromEntries(['name','label','factor','measure_unit_id','quantity_decimals','purchase_enabled','sale_enabled','price','price_wholesale','price_promotion','promotion_valid_until'].map(k=>[k,old[k]])):{}
  const contentChanged=old&&['factor','quantity_decimals','measure_unit_id'].some(key=>data[key]!==undefined&&(key==='factor'?factorText(data[key])!==factorText(old[key]):String(data[key]??'')!==String(old[key]??'')))
  const previousCodes=old?await tx.productBarcode.findMany({where:{company_id:scope.companyId,product_id:productId,presentation_id:old.id,active:true}}):[]
  if(contentChanged&&previousCodes.some(previous=>previous.code===barcode))fail(409,'El contenido cambió; asigna un código diferente para conservar el significado de las etiquetas impresas','BARCODE_CONFLICT')
  const row=await tx.productPresentation.create({data:{...inherited,...data,company_id:scope.companyId,product_id:productId,version:old?old.version+1:1}})
  const defaults={}
  if(old){
    await tx.productPresentation.update({where:{id:old.id},data:{active:false,successor_id:row.id}})
    for(const [key,enabled] of [['default_purchase_presentation_id','purchase_enabled'],['default_sale_presentation_id','sale_enabled']])if(product[key]===old.id)defaults[key]=row.active!==false&&row[enabled]!==false?row.id:null
    for(const previous of previousCodes){
      if(!contentChanged&&(barcode===undefined||barcode===previous.code)){await tx.productBarcode.update({where:{id:previous.id},data:{presentation_id:row.id,active:row.active!==false}})}
      else await tx.productBarcode.update({where:{id:previous.id},data:{active:false}})
    }
  }
  if(barcode)await reserveCode(tx,scope,barcode,{productId,presentationId:row.id})
  await bumpRevision(tx,product,{...defaults,unit_metadata_version:2})
  return row
}
module.exports={listPresentations,savePresentation}
