const {createHash}=require('node:crypto')
const {object,uuid,fail}=require('./credentials')
const {parseQuantity}=require('../../services/units/quantity')
const {parseCustomerReference}=require('./customers')
function text(value,max){if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail(400);return value.trim()}
function id(value){if(!uuid(value))fail(400);return value.toLowerCase()}
function parseDraftItems(items){
 if(!Array.isArray(items)||items.length<1||items.length>100)fail(400)
 return items.map(item=>{
  object(item,['productId','quantity','presentationId','unitRevision'])
  if(typeof item.quantity!=='string'||item.quantity.length>128||!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(item.quantity))fail(400)
  let quantity;try{quantity=parseQuantity(item.quantity,{decimals:12}).toFixed()}catch{fail(400)}
  const line={productId:id(item.productId),quantity}
  if(item.presentationId!==undefined)line.presentationId=item.presentationId===null?null:id(item.presentationId)
  if(item.unitRevision!==undefined){if(!Number.isSafeInteger(item.unitRevision)||item.unitRevision<1)fail(400);line.unitRevision=item.unitRevision}
  return line
 })
}
function parseDraftInput(raw){
 object(raw,['branchId','customerId','customer','items','notes','externalReference'])
 if(Object.hasOwn(raw,'customerId')===Object.hasOwn(raw,'customer'))fail(400)
 const out={branchId:id(raw.branchId),...(raw.customerId!==undefined?{customerId:id(raw.customerId)}:{customer:parseCustomerReference(raw.customer)}),items:parseDraftItems(raw.items)}
 if(raw.notes!==undefined)out.notes=text(raw.notes,2000)
 if(raw.externalReference!==undefined)out.externalReference=text(raw.externalReference,100)
 return out
}
function parseDraftKey(value){if(typeof value!=='string'||!/^[A-Za-z0-9._:-]{16,100}$/.test(value))fail(400);return value}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value}
function draftInputHash(type,input){return createHash('sha256').update(JSON.stringify(canonical({type,...input}))).digest('hex')}
module.exports={parseDraftInput,parseDraftItems,parseDraftKey,draftInputHash,canonical,text}
