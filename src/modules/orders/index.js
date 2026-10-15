const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {lockedOrder,deliver,invoice}=require('./fulfillment')
const {validateSnapshot}=require('../sales/engagementSale')
const {resolveEffectiveModules}=require('../platform/registry')
function fail(code,message,status=409){throw Object.assign(new Error(message),{code,status})}
function request(scope,id,body={}){return {companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId},params:{id},body}}
async function lockEngagementOrder(tx,scope,orderId){return lockedOrder(tx,request(scope,orderId),{separateOnly:false})}
function operationUuid(key){const hex=createHash('sha256').update(key).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`}
async function invoiceEngagementOrder(tx,scope,{orderId,source,idempotencyKey,settlement,draftSaleId}){
  if(!scope.isAdmin&&(!scope.permissions.includes('orders.view')||!scope.permissions.includes('orders.manage')))fail('FORBIDDEN','Necesitas permiso para gestionar y facturar el pedido',403)
  const modules=resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.find(m=>m.code==='orders')?.effectiveEnabled)fail('MODULE_DISABLED','Pedidos no está habilitado',403)
  const order=await lockEngagementOrder(tx,scope,orderId)
  if(order.fulfillment_mode!=='SEPARATE')fail('SOURCE_REVIEW_REQUIRED','Este pedido conserva el flujo anterior; revisa su facturación existente')
  validateSnapshot(source)
  if(order.customer_contact_id!==source.customer_id||!order.total.eq(source.agreed_total)||order.lines.length!==source.lines.length)fail('SOURCE_REVIEW_REQUIRED','El pedido cambió respecto de lo contratado')
  if(await tx.commercialDocumentSale.count({where:{document_id:order.id}})||order.lines.some(l=>l.qty_invoiced.gt(0)))fail('SOURCE_REVIEW_REQUIRED','El pedido ya tiene facturación; revisa sus ventas existentes')
  const services=[]
  for(const line of order.lines){
    const original=source.lines.find(l=>l.sort_order===line.sort_order&&l.product_id===line.product_id)
    if(!original||line.item_kind!==original.item_kind||!line.qty.eq(original.qty)||!line.unit_price.eq(original.unit_price)||!line.line_total.eq(original.line_total))fail('SOURCE_REVIEW_REQUIRED','Las partidas del pedido cambiaron')
    if(line.qty_fulfilled.lt(line.qty)){
      if(line.item_kind!=='SERVICE')fail('GOODS_DELIVERY_REQUIRED','Entrega los bienes desde Pedidos antes de facturar esta contratación')
      const performed=original.schedules.filter(s=>s.state!=='RELEASED'&&s.state!=='CANCELLED'&&(s.booking?s.booking.status==='COMPLETED':s.session.status==='COMPLETED'&&s.session.commercial_completion_confirmed_at)).reduce((sum,s)=>sum.add(s.quantity),new Prisma.Decimal(0))
      if(performed.lt(line.qty))fail('SERVICE_DELIVERY_REQUIRED','Confirma la prestación de todos los servicios antes de facturar el pedido')
      services.push({line_id:line.id,qty:line.qty.sub(line.qty_fulfilled).toString()})
    }
  }
  if(services.length)await deliver(tx,request(scope,order.id,{request_key:operationUuid(`delivery:${source.id}:${idempotencyKey}`),lines:services,notes:'Prestación confirmada desde Agenda'}))
  const result=await invoice(tx,request(scope,order.id,{request_key:operationUuid(`invoice:${source.id}:${idempotencyKey}`),lines:order.lines.map(l=>({line_id:l.id,qty:l.qty.toString()})),payment_method_id:settlement.paymentMethodId}),()=>{throw Error('Existing receipts never require another cash receipt')},{...settlement,engagementId:source.id,draftSaleId})
  if(!result.sale.total.eq(source.agreed_total))fail('SOURCE_REVIEW_REQUIRED','El importe facturado no concilia con lo contratado')
  return result.sale
}
module.exports={invoiceEngagementOrder,lockEngagementOrder}
