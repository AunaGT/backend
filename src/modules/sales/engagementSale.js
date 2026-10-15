const {Prisma}=require('@prisma/client')
const {money}=require('../receivables')
const {moveSaleStock,insertSaleRecord}=require('./application')
const {commercialState}=require('./commercialState')
const {createHash}=require('node:crypto')
const {assertLinesAvailable,consumeByDocument}=require('../../services/stockAvailability')
const {nextDocumentReference}=require('../../services/referenceGenerator')
const {lineSnapshot}=require('../../services/catalogItemRules')
function fail(code,message,status=409){throw Object.assign(new Error(message),{code,status})}
function validateSnapshot(source){
  const total=money(source.agreed_total)
  const sum=source.lines.reduce((sum,l)=>sum.add(money(l.line_total)),new Prisma.Decimal(0))
  if(!sum.eq(total))fail('SOURCE_REVIEW_REQUIRED','Las partidas no concilian con el total acordado; revisa la fuente comercial')
  return total
}
async function ensureEngagementDraft(tx,scope,{source}){
  const total=validateSnapshot(source)
  if(source.company_id!==scope.companyId||source.branch_id!==scope.branchId)fail('NOT_FOUND','Contratación no encontrada',404)
  const existing=await tx.sale.findFirst({where:{branch_id:scope.branchId,origin_engagement_id:source.id},include:{status:true}})
  if(existing){
    const state=commercialState(existing.status.name)
    if(!['DRAFT','CONFIRMED'].includes(state))fail('SOURCE_REVIEW_REQUIRED','Resuelve el alcance comercial; el borrador no se reactivará automáticamente')
    return {saleId:existing.id,state,created:false}
  }
  if(source.sale_id)fail('SOURCE_REVIEW_REQUIRED','Revisa el vínculo de la venta existente; no se creará otra venta')
  const items=source.lines.map(l=>({product_id:l.product_id,qty:l.qty,unit_price:l.unit_price,line_total:l.line_total,...lineSnapshot(l)}))
  const products=await tx.product.findMany({where:{company_id:scope.companyId,id:{in:items.map(l=>l.product_id)}},select:{id:true,kind:true,cost:true}})
  for(const item of items){
    const product=products.find(p=>p.id===item.product_id)
    if(!product||product.kind!==item.item_kind)fail('SOURCE_REVIEW_REQUIRED','Una partida ya no corresponde al alcance contratado')
    item.unit_cost=item.item_kind==='SERVICE'?0:product.cost
  }
  const branch=await tx.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId},select:{id:true,code:true,seq:true}})
  const status=await tx.saleStatus.findUnique({where:{name:'Borrador'}})
  if(!branch||!status)fail('SALE_CONFIGURATION_REQUIRED','Configura sucursal y estado de borrador')
  const snapshot=source.commercial_snapshot
  const sale=await insertSaleRecord(tx,{items,userId:scope.userId,saleData:{
    branch_id:scope.branchId,origin_engagement_id:source.id,status_id:status.id,reference:await nextDocumentReference(tx,'V',branch),
    customer_contact_id:source.customer_id,customer:source.customer.name,customer_nit:snapshot.customerNit||null,
    is_final_consumer:snapshot.isFinalConsumer??true,sales_channel:snapshot.salesChannel||'POS',
    payment_method_id:null,payment_status:'PENDING',settlement_source:'ENGAGEMENT_RECEIPTS',
    amount_received:null,change:null,cash_register_session_id:null,
    items:items.filter(l=>l.item_kind!=='SERVICE').reduce((sum,l)=>sum+Number(l.qty),0),
    subtotal:snapshot.subtotal||total.toFixed(2),discount_total:snapshot.discountTotal||'0.00',total:total.toFixed(2),adjusted_total:total.toFixed(2),
  }})
  const requestKey=`draft:${source.id}`
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:sale.id,actor_id:scope.userId,
    action:'DRAFT_CREATED',request_key:requestKey,input_hash:createHash('sha256').update(source.id).digest('hex'),after:{engagementId:source.id}}})
  return {saleId:sale.id,state:'DRAFT',created:true}
}
async function createSaleFromEngagement(tx,scope,{source,idempotencyKey,settlement}){
  const draft=await ensureEngagementDraft(tx,scope,{source})
  return confirmEngagementDraft(tx,scope,{source,draftSaleId:draft.saleId,idempotencyKey,settlement})
}
async function confirmEngagementDraft(tx,scope,{source,draftSaleId,idempotencyKey,settlement}){
  if(settlement?.kind!=='EXISTING_RECEIPTS')fail('INVALID_SETTLEMENT','La venta necesita su liquidación autorizada')
  const total=validateSnapshot(source)
  await tx.$queryRaw`SELECT id FROM sales WHERE id=${draftSaleId}::uuid AND branch_id=${scope.branchId}::uuid FOR UPDATE`
  const draft=await tx.sale.findFirst({where:{id:draftSaleId,branch_id:scope.branchId,origin_engagement_id:source.id,branch:{company_id:scope.companyId}},include:{status:true,sale_items:{orderBy:{id:'asc'}}}})
  if(!draft)fail('NOT_FOUND','Borrador no encontrado',404)
  if(draft.status.name!=='Borrador')fail('SOURCE_REVIEW_REQUIRED','Esta venta no admite confirmación desde este estado')
  if(!draft.total.eq(total)||draft.sale_items.length!==source.lines.length)fail('SOURCE_REVIEW_REQUIRED','El borrador no coincide con el alcance acordado')
  const original=[...source.lines].sort((a,b)=>a.sort_order-b.sort_order)
  for(const [i,l]of original.entries()){
    const s=draft.sale_items[i]
    if(s.product_id!==l.product_id||s.item_kind!==l.item_kind||s.item_name!==l.item_name||s.unit_label!==l.unit_label||s.quantity_decimals!==l.quantity_decimals||!s.qty.eq(l.qty)||!s.price.eq(l.unit_price)||!s.net_total?.eq(l.line_total))
      fail('SOURCE_REVIEW_REQUIRED','Las partidas del borrador cambiaron; revisa la contratación')
  }
  const items=source.lines.map(l=>({product_id:l.product_id,qty:l.qty,unit_price:l.unit_price,line_total:l.line_total,...lineSnapshot(l)}))
  await assertLinesAvailable(tx,items,{branchId:source.branch_id,companyId:scope.companyId,excludeDocumentId:source.quote_id||undefined,allowArchivedServices:true})
  const products=await tx.product.findMany({where:{company_id:scope.companyId,id:{in:items.map(l=>l.product_id)}},select:{id:true,cost:true,kind:true}})
  for(const item of items){
    const product=products.find(p=>p.id===item.product_id)
    if(!product||product.kind!==item.item_kind)fail('SOURCE_REVIEW_REQUIRED','El tipo de una partida cambió; revisa la fuente comercial')
    item.unit_cost=item.item_kind==='SERVICE'?0:product.cost
  }
  const status=await tx.saleStatus.findFirst({where:{name:'Completada'}})
  if(!status)fail('SALE_CONFIGURATION_REQUIRED','Configura el estado de venta')
  const sale=await tx.sale.update({where:{id:draft.id,version:draft.version},data:{
    date:settlement.issuedAt,sold_at:settlement.issuedAt,confirmed_at:settlement.issuedAt,status_id:status.id,version:{increment:1},
    payment_method_id:settlement.paymentMethodId,payment_status:total.eq(0)?'PAID':'PENDING',due_date:settlement.dueDate,
    idempotency_key:idempotencyKey,
  }})
  for(const line of draft.sale_items)await tx.saleItem.update({where:{id:line.id},data:{unit_cost:items.find(l=>l.product_id===line.product_id).unit_cost}})
  await moveSaleStock(tx,items,source.branch_id,{reason:'SALE',refType:'sale',refId:sale.id,userId:scope.userId,companyId:scope.companyId,allowArchivedServices:true})
  if(source.quote_id)await consumeByDocument(tx,source.quote_id)
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:sale.id,actor_id:scope.userId,action:'SALE_CONFIRMED',request_key:idempotencyKey,
    input_hash:createHash('sha256').update(`${source.id}:${draft.version}`).digest('hex'),before:{state:'DRAFT'},after:{state:'CONFIRMED',engagementId:source.id}}})
  return sale
}
module.exports={createSaleFromEngagement,validateSnapshot,ensureEngagementDraft,confirmEngagementDraft}
