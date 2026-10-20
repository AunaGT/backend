const Units=require('../../modules/inventory/units')
const {parseQuantity,convertQuantity}=require('./quantity')
const fail=message=>{throw Object.assign(new Error(message),{status:400})}
function importUnitInput(row){
  const cells=Object.fromEntries(Object.entries(row).map(([key,value])=>[key.trim().toLowerCase(),value]))
  return {base_unit_code:String(cells.base_unit_code??cells.unidad_base??'').trim().toUpperCase(),presentation_code:String(cells.presentation_code??cells.codigo_presentacion??'').trim(),presentation_content:String(cells.presentation_content??cells.contenido_presentacion??'').trim(),quantity_decimals:cells.quantity_decimals??cells.decimales}
}
async function resolveImportUnitRow(tx,companyId,input,data,existingProductId){
  const explicit=!!(input.base_unit_code||input.presentation_code||input.presentation_content)
  const enabled=await Units.unitsEnabled(tx,companyId)
  if(explicit&&!enabled)fail('Las unidades están desactivadas en esta empresa')
  if(!enabled&&!explicit)return null
  if(data.kind==='SERVICE'){if(explicit)fail('Los servicios conservan su unidad de cobro, sin presentaciones físicas');return null}
  const product=existingProductId?await tx.product.findFirst({where:{id:existingProductId,company_id:companyId,deleted:false}}):null
  if(existingProductId&&!product)fail('Producto no encontrado en esta empresa')
  if(Units.advancedProduct(product)&&!input.base_unit_code)fail('El producto requiere un código explícito de unidad base')
  if(!input.base_unit_code){
    if(input.presentation_code||input.presentation_content)fail('Declara la unidad base antes de la presentación')
    parseQuantity(data.stock??0,{decimals:0,allowZero:true});parseQuantity(data.min_stock??0,{decimals:0,allowZero:true})
    if(input.quantity_decimals!=null&&String(input.quantity_decimals)!=='0')fail('Una cantidad fraccionaria requiere una unidad base explícita')
    return null
  }
  if(input.base_unit_code.length>100||input.presentation_code.length>100)fail('Código de unidad o presentación demasiado largo')
  const base=await tx.measureUnit.findFirst({where:{company_id:companyId,code:input.base_unit_code,active:true}})
  if(!base)fail('Unidad base no encontrada en esta empresa')
  if(product&&product.base_unit_id!==base.id)fail('La unidad base del producto existente es inmutable; utiliza su código actual')
  const precision=input.quantity_decimals==null||input.quantity_decimals===''?(product?.quantity_decimals??base.quantity_decimals):Number(input.quantity_decimals)
  if(!Number.isInteger(precision)||precision<0||precision>Math.min(6,base.quantity_decimals)||((product?.kind??data.kind)==='KIT'&&precision!==0))fail('Precisión física inválida para la unidad base')
  if(product&&precision!==product.quantity_decimals)fail('La precisión no coincide con la configuración del producto')
  let presentation=null
  if(input.presentation_code){
    if(!product)fail('La presentación debe estar registrada en la ficha del producto; esta importación no crea presentaciones')
    const codes=await tx.productBarcode.findMany({where:{company_id:companyId,product_id:product.id,code:input.presentation_code,active:true,presentation_id:{not:null}}})
    if(codes.length!==1)fail('Presentación no encontrada o ambigua en esta empresa')
    presentation=await tx.productPresentation.findFirst({where:{id:codes[0].presentation_id,company_id:companyId,product_id:product.id,active:true}})
    if(!presentation)fail('La presentación está archivada o no pertenece al producto')
  }
  const factor=presentation?.factor??'1'
  if(input.presentation_content&&!parseQuantity(input.presentation_content,{decimals:12,max:'99999999.999999999999'}).eq(factor))fail('El contenido no coincide con el factor registrado; no se reinterpretó la fila')
  const convert=value=>{const qty=parseQuantity(String(value??0),{decimals:presentation?.quantity_decimals??precision,allowZero:true});return qty.isZero()?'0':convertQuantity(qty.toFixed(),factor,{baseDecimals:precision,commercialDecimals:presentation?.quantity_decimals??precision,allowRounding:false}).baseQty}
  return {baseStock:convert(data.stock),baseMinimum:convert(data.min_stock),base_unit_id:base.id,quantity_decimals:precision,unitLabel:base.label,presentationLabel:presentation?.label??base.label,priceCostPolicy:product?'Precio y costo existentes sin cambios; solo fija existencias iniciales.':'Precio y costo por unidad base.',configuration:product?null:{base_unit_id:base.id,quantity_decimals:precision,presentations:[]},presentation_id:presentation?.id??null}
}
module.exports={importUnitInput,resolveImportUnitRow}
