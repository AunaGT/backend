const {publicServiceConditions}=require('../appointments')
function fail(status,code,message){throw Object.assign(new Error(message),{status,code})}
async function lockQuote(tx,scope,quoteId){
  if(!scope.branchId) fail(400,'BRANCH_REQUIRED','Selecciona una sucursal')
  if(!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(quoteId)) fail(400,'INVALID_INPUT','Cotización inválida')
  const locked=await tx.$queryRaw`SELECT d.id FROM commercial_documents d JOIN branches b ON b.id=d.branch_id WHERE d.id=${quoteId}::uuid AND d.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND d.doc_type='QUOTE' FOR UPDATE OF d`
  if(!locked.length) fail(404,'NOT_FOUND','Cotización no encontrada')
  return tx.commercialDocument.findFirst({where:{id:quoteId,branch_id:scope.branchId,branch:{company_id:scope.companyId},doc_type:'QUOTE'},
    include:{lines:{orderBy:{sort_order:'asc'}},customerContact:true,convertedChildren:{where:{doc_type:'ORDER'},include:{documentSales:true}},quoted_engagement:{select:{id:true,sale_id:true}}}})
}
async function assertQuoteSourceAccess(tx,scope){
  if(!scope.isAdmin&&!scope.permissions?.includes('quotes.view')) fail(403,'FORBIDDEN','Necesitas permiso para consultar cotizaciones')
  const modules=require('../platform/registry').resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.find(m=>m.code==='quotes')?.effectiveEnabled)fail(403,'MODULE_DISABLED','Cotizaciones no está habilitado para esta empresa')
}
async function loadQuoteSource(tx,scope,quoteId){
  await assertQuoteSourceAccess(tx,scope)
  const quote=await lockQuote(tx,scope,quoteId)
  if(quote.status!=='ACCEPTED') fail(409,'QUOTE_NOT_ACCEPTED','Solo puedes agendar una cotización aceptada')
  if(!quote.customerContact||quote.customerContact.company_id!==scope.companyId||quote.customerContact.deleted||quote.customerContact.party_type!=='CUSTOMER') fail(400,'CONTACT_REQUIRED','Vincula un cliente registrado a la cotización antes de agendar')
  const setting=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}})
  return {id:quote.id,branchId:quote.branch_id,customerId:quote.customer_contact_id,currencyCode:setting?.value||'GTQ',total:quote.total.toFixed(2),
    reference:quote.reference,subtotal:quote.subtotal?.toFixed(2)??quote.total.toFixed(2),discountTotal:quote.discount_total?.toFixed(2)??'0.00',
    customer:quote.customer,customerNit:quote.customer_nit,isFinalConsumer:quote.is_final_consumer,paymentCondition:quote.payment_condition,creditDays:quote.credit_days,
    salesChannel:quote.sales_channel,notes:quote.notes,engagement:quote.quoted_engagement,orders:quote.convertedChildren,
    lines:quote.lines.map(l=>({id:l.id,productId:l.product_id,itemKind:l.item_kind,itemName:l.item_name,unitLabel:l.unit_label,quantityDecimals:l.quantity_decimals,
      quantity:l.qty.toFixed(4),unitPrice:l.unit_price.toFixed(2),lineTotal:l.line_total.toFixed(2),sortOrder:l.sort_order,
      serviceConditions:l.item_kind==='SERVICE'?publicServiceConditions(l.service_schedule_snapshot):null}))}
}
module.exports={lockQuote,loadQuoteSource,assertQuoteSourceAccess}
