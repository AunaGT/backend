const {objectInput,fail,authorize,assertEnabled,lockProduct}=require('./access')
const {resolveUnitLine}=require('./lines')
const {parseQuantity}=require('../../../services/units/quantity')
const uuid=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
function parsePreviewBatch(raw){
 objectInput(raw,['lines'])
 if(!Array.isArray(raw.lines)||!raw.lines.length||raw.lines.length>200)fail(400,'Selecciona entre 1 y 200 líneas para revisar')
 const keys=new Set()
 const lines=raw.lines.map(line=>{
  objectInput(line,['client_line_key','product_id','qty','presentation_id','unit_revision','accept_rounding','price_tier'])
  if(typeof line.client_line_key!=='string'||!line.client_line_key.trim()||line.client_line_key.length>500||keys.has(line.client_line_key))fail(400,'Cada línea necesita una referencia única')
  keys.add(line.client_line_key)
  if(typeof line.product_id!=='string'||!uuid.test(line.product_id)||line.presentation_id!=null&&(typeof line.presentation_id!=='string'||!uuid.test(line.presentation_id)))fail(400,'Producto o presentación no válidos')
  if(!Number.isSafeInteger(line.unit_revision)||line.unit_revision<1||line.accept_rounding!==undefined&&typeof line.accept_rounding!=='boolean'||line.price_tier!==undefined&&!['LIST','WHOLESALE','PROMOTION'].includes(line.price_tier))fail(400,'Revisión o tarifa no válidas')
  if(typeof line.qty!=='string'||line.qty.length>100)fail(400,'Cantidad no válida')
  parseQuantity(line.qty,{decimals:6})
  return {...line}
 })
 return {lines}
}
async function previewUnitBatch(tx,scope,raw){
 const {lines}=parsePreviewBatch(raw)
 authorize(scope,['sales.create','orders.create','quotes.create'],true)
 await assertEnabled(tx,scope)
 return require('../../../services/checkoutContext').withCheckoutContext(tx,scope,lines,async()=>{
 const products=new Map()
 for(const id of [...new Set(lines.map(line=>line.product_id))].sort())products.set(id,await lockProduct(tx,scope,id))
 const items=[]
 for(const {client_line_key,product_id,...input} of lines){
  const preview=await resolveUnitLine(tx,scope,products.get(product_id),input,{operation:'SALE'})
  items.push({client_line_key,preview})
 }
 return {items}
 })
}
module.exports={parsePreviewBatch,previewUnitBatch}
