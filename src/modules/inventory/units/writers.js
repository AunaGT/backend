const {parseQuantity}=require('../../../services/units/quantity')
const {fail,advancedProduct,unitsEnabled,assertEnabled,lockCompany,lockProduct,authorize,revision,bumpRevision,objectInput,decimals}=require('./access')
const {CONFIG_KEYS,configureProduct,extendProductDTO}=require('./catalog')
const {savePresentation}=require('./presentations')
const {normalizeCode,assertCodeAvailable,syncBaseBarcode}=require('./barcodes')
function assertPublicProductInput(input,{create=false}={}) {
  for(const key of ['factor','base_qty','unit_snapshot','unit_metadata_version','base_unit','base_unit_locked','presentations','barcodes','default_purchase_presentation','default_sale_presentation',...(!create?['units_configuration']:[])])if(Object.hasOwn(input,key))fail(400,'El servidor determina las definiciones de unidad y los snapshots')
}
async function prepareProductWrite(tx,scope,current,input,data,{create=false}={}) {
  assertPublicProductInput(input,{create:create&&!current})
  const creation=input.units_configuration
  if(creation!==undefined){
    if(CONFIG_KEYS.some(key=>Object.hasOwn(input,key))||Object.hasOwn(input,'unit_revision'))fail(400,'No combines la configuración inicial con campos de unidad existentes')
    objectInput(creation,['base_unit_id','quantity_decimals','presentations','default_purchase_key','default_sale_key'])
    if(typeof creation.base_unit_id!=='string'||!Array.isArray(creation.presentations)||creation.presentations.length>50)fail(400,'Configuración inicial de unidades inválida')
    const keys=new Set()
    for(const row of creation.presentations){
      objectInput(row,['client_key','name','label','quantity_decimals','factor','measure_unit_id','purchase_enabled','sale_enabled','active','prices','promotion_valid_until','barcode'])
      if(typeof row.client_key!=='string'||!row.client_key.trim()||row.client_key.length>100||keys.has(row.client_key))fail(400,'Cada presentación inicial necesita una referencia única')
      keys.add(row.client_key)
    }
    for(const key of ['default_purchase_key','default_sale_key'])if(creation[key]!=null&&!keys.has(creation[key]))fail(400,'La presentación predeterminada no pertenece al producto nuevo')
    delete data.units_configuration
  }
  if((current?.kind??input.kind??'STANDARD')!=='SERVICE'&&!current?.base_unit_id&&!input.base_unit_id&&input.quantity_decimals!==undefined&&input.quantity_decimals!==0)fail(400,'Configura una unidad base antes de cambiar la precisión física')
  const configKeys=CONFIG_KEYS.filter(k=>Object.hasOwn(input,k)&&(k!=='quantity_decimals'||advancedProduct(current)||input.base_unit_id))
  const hasConfig=configKeys.length>0||creation!==undefined
  const priceKeys=['price','price_wholesale','price_promotion','promotion_valid_until']
  const hasPricing=priceKeys.some(key=>Object.hasOwn(input,key))
  const barcode=Object.hasOwn(input,'barcode')
  for(const key of [...CONFIG_KEYS.filter(k=>k!=='quantity_decimals'),'unit_revision'])delete data[key]
  if(hasConfig)delete data.quantity_decimals
  if(!hasConfig&&!barcode&&!current?.base_unit_id&&!hasPricing)return product=>product
  const enabled=await unitsEnabled(tx,scope.companyId)
  if(hasConfig&&!enabled)fail(403,'Las unidades y presentaciones están desactivadas')
  if(!enabled){
    if(!barcode||!tx.productBarcode)return product=>product
    await lockCompany(tx,scope.companyId)
    if(current)await lockProduct(tx,scope,current.id)
    data.barcode=input.barcode==null||input.barcode===''?null:normalizeCode(input.barcode)
    if(data.barcode)await assertCodeAvailable(tx,scope,data.barcode,{productId:current?.id})
    return async product=>{await syncBaseBarcode(tx,scope,product.id,data.barcode);return product}
  }
  authorize(scope,['products.edit','products.create','products.import'],true)
  await lockCompany(tx,scope.companyId)
  await assertEnabled(tx,scope)
  if(input.cost!==undefined&&input.cost!==null)data.cost=parseQuantity(input.cost,{decimals:6,allowZero:true,max:'9999999999.99'}).toFixed()
  let initialStock
  if(creation){
    const base=await tx.measureUnit.findFirst({where:{id:creation.base_unit_id,company_id:scope.companyId,active:true}})
    if(!base)fail(404,'Unidad base no encontrada')
    const precision=creation.quantity_decimals??base.quantity_decimals
    const kind=data.kind??input.kind
    decimals(precision,kind==='KIT'?0:kind==='SERVICE'?4:6)
    if(precision>base.quantity_decimals)fail(400,'La precisión excede la unidad base')
    creation.quantity_decimals=precision
    initialStock=parseQuantity(input.stock??'0',{decimals:precision,allowZero:true}).toFixed()
    if(input.min_stock!==undefined)data.min_stock=parseQuantity(input.min_stock,{decimals:precision,allowZero:true}).toFixed()
    // Initial units belong in the INSERT; an uncommitted new product has no history to scan.
    Object.assign(data,{base_unit_id:base.id,quantity_decimals:precision,unit_metadata_version:2})
  }
  if(current)current=await lockProduct(tx,scope,current.id)
  if(current?.base_unit_id&&input.kind!==undefined&&input.kind!==current.kind)fail(409,'El tipo de un producto con unidad base no se puede cambiar')
  const config=Object.fromEntries(configKeys.map(key=>[key,input[key]]))
  for(const key of ['price','price_wholesale','price_promotion'])if(input[key]!=null&&input[key]!=='')data[key]=parseQuantity(input[key],{decimals:6,allowZero:true,max:'9999999999.99'}).toFixed()
  const priceValue=(key,value)=>value==null||value===''?null:key==='promotion_valid_until'?new Date(value).toISOString():parseQuantity(value,{decimals:6,allowZero:true,max:'9999999999.99'}).toFixed()
  const pricingChanged=advancedProduct(current)&&priceKeys.some(key=>Object.hasOwn(input,key)&&priceValue(key,input[key])!==priceValue(key,current[key]))
  if(pricingChanged)revision(current,input.unit_revision)
  if(current&&hasConfig)await configureProduct(tx,scope,current.id,{...config,unit_revision:input.unit_revision})
  else if(pricingChanged)await bumpRevision(tx,current)
  if(barcode){data.barcode=input.barcode==null||input.barcode===''?null:normalizeCode(input.barcode);if(data.barcode)await assertCodeAvailable(tx,scope,data.barcode,{productId:current?.id})}
  const finish=async product=>{
    let saved=product
    if(creation){
      const ids=new Map()
      for(const {client_key,...presentation} of creation.presentations){
        const row=await savePresentation(tx,scope,product.id,{...presentation,unit_revision:saved.unit_revision})
        ids.set(client_key,row.id);saved=await tx.product.findFirst({where:{id:product.id,company_id:scope.companyId}})
      }
      const defaults={}
      for(const [key,target] of [['default_purchase_key','default_purchase_presentation_id'],['default_sale_key','default_sale_presentation_id']])if(creation[key]!==undefined)defaults[target]=creation[key]===null?null:ids.get(creation[key])
      if(Object.keys(defaults).length)saved=await configureProduct(tx,scope,product.id,{...defaults,unit_revision:saved.unit_revision})
    }else if(!current&&hasConfig)saved=await configureProduct(tx,scope,product.id,{...config,unit_revision:product.unit_revision??1})
    if(barcode)await syncBaseBarcode(tx,scope,product.id,data.barcode)
    return (await extendProductDTO(tx,scope,[saved]))[0]
  }
  finish.initialStock=initialStock
  return finish
}
module.exports={assertPublicProductInput,prepareProductWrite}
