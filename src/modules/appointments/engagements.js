const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const v=require('./domain/validation')
const {command,requireAction,checkVersion,contact}=require('./application')
const {getEngagement,loadEngagement,engagementWhere}=require('./commercialQueries')
const {loadQuoteSource}=require('../quotes')
const {lineSnapshot,commercialQuantity}=require('../../services/catalogItemRules')
const {assertCatalogIntegration}=require('./access')
const {publicConditionsFromRow}=require('./index')
const {money}=require('../receivables')
function parseEngagement(raw){
  const input=v.object(raw,['quoteId','contactId','lines','idempotencyKey'])
  const key=v.requestKey(v.text(input.idempotencyKey,'idempotencyKey',64))
  if(input.quoteId){
    if(input.contactId!==undefined||input.lines!==undefined)v.invalid('quoteId','La contratación toma el cliente y partidas de la cotización')
    return {quoteId:v.uuid(input.quoteId,'quoteId'),idempotencyKey:key}
  }
  if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>100)v.invalid('lines','Agrega entre 1 y 100 servicios')
  return {contactId:v.uuid(input.contactId,'contactId'),idempotencyKey:key,lines:input.lines.map(line=>{
    const l=v.object(line,['productId','quantity'])
    return {productId:v.uuid(l.productId,'productId'),quantity:v.quantity(l.quantity)}
  })}
}
async function directSource(tx,scope,input){
  await assertCatalogIntegration(tx,scope);await contact(tx,scope,input.contactId)
  const products=await tx.product.findMany({where:{company_id:scope.companyId,id:{in:input.lines.map(l=>l.productId)},kind:'SERVICE',deleted:false,available_for_sale:true},include:{service_schedule_profile:true}})
  const lines=input.lines.map((l,i)=>{
    const p=products.find(p=>p.id===l.productId)
    if(!p)v.fail(400,'SERVICE_UNAVAILABLE','Selecciona un servicio activo de esta empresa')
    const snap=lineSnapshot(p),qty=commercialQuantity(l.quantity,p),unitPrice=new Prisma.Decimal(p.price),lineTotal=unitPrice.mul(qty).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP)
    return {productId:p.id,itemName:snap.item_name,itemKind:'SERVICE',unitLabel:snap.unit_label,quantityDecimals:snap.quantity_decimals,quantity:qty.toFixed(4),unitPrice:unitPrice.toFixed(2),lineTotal:lineTotal.toFixed(2),serviceConditions:publicConditionsFromRow(p.service_schedule_profile),sortOrder:i}
  })
  const currency=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}})
  return {customerId:input.contactId,currencyCode:currency?.value||'GTQ',total:lines.reduce((sum,l)=>sum.add(l.lineTotal),new Prisma.Decimal(0)).toFixed(2),lines,orders:[]}
}
async function createEngagement(db,scope,raw){
  const input=parseEngagement(raw)
  return command(db,scope,'appointments.create','CREATE_ENGAGEMENT',input,async tx=>{
    const source=input.quoteId?await loadQuoteSource(tx,scope,input.quoteId):await directSource(tx,scope,input)
    money(source.total)
    for(const line of source.lines){money(line.unitPrice);money(line.lineTotal)}
    if(input.quoteId){
      const existing=await tx.appointmentEngagement.findFirst({where:{quote_id:input.quoteId,...engagementWhere(scope)}})
      if(existing)return {type:'ENGAGEMENT',id:existing.id}
      if(source.engagement)v.fail(404,'NOT_FOUND','La cotización ya está vinculada a una contratación no accesible')
    }
    if(!source.lines.some(l=>l.itemKind==='SERVICE'))v.fail(400,'NO_SERVICES','La cotización no contiene servicios para agendar')
    if(source.orders.length>1)v.fail(409,'SOURCE_REVIEW_REQUIRED','La cotización tiene varios pedidos; revisa sus documentos vinculados')
    const order=source.orders[0]
    if(order){await require('../orders').lockEngagementOrder(tx,scope,order.id);order.documentSales=await tx.commercialDocumentSale.findMany({where:{document_id:order.id}})}
    const row=await require('./engagementRecords').createEngagementRecord(tx,scope,{source,quoteId:input.quoteId,requestKey:input.idempotencyKey,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex')})
    return {type:'ENGAGEMENT',id:row.id}
  })
}
async function loadLockedEngagement(tx,scope,id,expectedVersion,permission='appointments.edit'){
  requireAction(scope,permission)
  const row=await loadEngagement(tx,scope,id)
  await tx.$queryRaw`SELECT id FROM appointment_engagements WHERE id=${row.id}::uuid FOR UPDATE`
  const locked=await loadEngagement(tx,scope,id)
  checkVersion(locked,expectedVersion)
  return locked
}
async function programEngagement(db,scope,id,raw){
  return require('./engagementScheduling').programEngagement(db,scope,id,raw)
}
module.exports={createEngagement,getEngagement,programEngagement,loadLockedEngagement,parseEngagement}
