const {createHash}=require('node:crypto')
const v=require('./domain/validation')
const {command}=require('./application')
const {assertCommercialAccess,hasAgendaPermission}=require('./access')
const {loadEngagement}=require('./commercialQueries')
const {loadLockedEngagement}=require('./engagements')
const {lockCustomer,checkCredit,money,engagementMoney,engagementCurrencyReason,applyEngagementCommitments,CUSTOMER_TERM_PICK}=require('../receivables')
const {creditDueDate,getTimezone}=require('../../services/commercialPayment')
const {ensureEngagementDraft,confirmEngagementDraft}=require('../sales')
function parseSale(raw){
  const p=v.object(raw,['expectedVersion','idempotencyKey','paymentCondition','dueDate','creditOverride','confirmGoodsDispatch'])
  const paymentCondition=p.paymentCondition||'CASH'
  if(!['CASH','CREDIT'].includes(paymentCondition))v.invalid('paymentCondition','Selecciona contado o crédito')
  for(const key of ['creditOverride','confirmGoodsDispatch'])if(p[key]!==undefined&&typeof p[key]!=='boolean')v.invalid(key,'Confirma la opción')
  return {expectedVersion:v.version(p.expectedVersion),idempotencyKey:v.requestKey(v.text(p.idempotencyKey,'idempotencyKey',64)),paymentCondition,
    dueDate:p.dueDate?v.text(p.dueDate,'dueDate',10):null,creditOverride:p.creditOverride===true,confirmGoodsDispatch:p.confirmGoodsDispatch===true}
}
async function issueEngagementSale(db,scope,id,raw){
  v.uuid(id,'engagementId');const input={id,...parseSale(raw)}
  await assertCommercialAccess(db,scope,'issue_sale')
  return command(db,scope,'appointments.issue_sale','ISSUE_ENGAGEMENT',input,async tx=>{
    await assertCommercialAccess(tx,scope,'issue_sale')
    const initial=await loadEngagement(tx,scope,id)
    await require('./sourceVerification').lockEngagementQuote(tx,scope,initial)
    if(initial.order_id)await require('../orders').lockEngagementOrder(tx,scope,initial.order_id)
    await lockCustomer(tx,initial.customer_id)
    const e=await loadLockedEngagement(tx,scope,id,input.expectedVersion,'appointments.issue_sale')
    if(e.sale_id)return {type:'ENGAGEMENT',id:e.id}
    const currencyReason=await engagementCurrencyReason(tx,scope,e)
    if(currencyReason)v.fail(409,'CURRENCY_MISMATCH',currencyReason)
    if(e.commercial_snapshot.replacementEngagementId)v.fail(409,'SCOPE_SUPERSEDED','Genera la venta desde la contratación que corrige este alcance')
    if(e.resolution_pending||require('./commercialQueries').hasCancelledSchedules(e.lines))v.fail(409,'SOURCE_REVIEW_REQUIRED','Resuelve las cancelaciones y el alcance comercial antes de generar venta')
    if(await tx.customerPaymentRefund.count({where:{engagement_id:id,status:'REQUESTED'}}))v.fail(409,'REFUND_PENDING','Resuelve la devolución pendiente antes de generar venta')
    const balance=await engagementMoney(tx,e),remaining=money(balance.remaining),now=new Date()
    if(!e.order_id&&e.lines.some(l=>l.item_kind!=='SERVICE')&&!input.confirmGoodsDispatch)v.fail(409,'DISPATCH_CONFIRMATION_REQUIRED','Confirma el despacho de los bienes incluidos; la venta descontará existencias')
    let dueDate=null
    if(remaining.gt(0)){
      if(input.paymentCondition!=='CREDIT')v.fail(409,'UNPAID_BALANCE','Completa el pago o selecciona crédito para dejar saldo pendiente')
      const setting=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'sales_allow_credit'}}})
      if(String(setting?.value??'true').toLowerCase()!=='true')v.fail(403,'CREDIT_DISABLED','Las ventas a crédito están desactivadas')
      const customer=await tx.supplier.findFirst({where:{id:e.customer_id,company_id:scope.companyId,deleted:false,estado:1,party_type:'CUSTOMER'},select:{id:true,credit_limit:true,supplier_payment_terms:CUSTOMER_TERM_PICK}})
      if(!customer)v.fail(400,'INVALID_CONTACT','El cliente no está activo en esta empresa')
      dueDate=creditDueDate(input.dueDate,e.commercial_snapshot.creditDays??customer.supplier_payment_terms[0]?.payment_term?.net_days,now,await getTimezone(tx,scope.companyId))
      const check=await checkCredit(tx,customer,remaining.toNumber(),{branch_id:scope.branchId})
      if(!check.ok&&!(input.creditOverride&&hasAgendaPermission(scope,'sales.credit.override')))v.fail(409,'CREDIT_NOT_AVAILABLE',check.motivo||'Crédito no disponible')
    }
    const method=await tx.paymentMethod.findFirst({where:{is_credit:remaining.gt(0)},orderBy:{id:'asc'}})
    if(!method)v.fail(409,'PAYMENT_METHOD_REQUIRED','Configura un medio comercial de pago')
    const settlement={kind:'EXISTING_RECEIPTS',committedAmount:balance.committed,issuedAt:now,dueDate,paymentMethodId:method.id}
    const draft=await ensureEngagementDraft(tx,scope,{source:e})
    const sale=e.order_id?await require('../orders').invoiceEngagementOrder(tx,scope,{orderId:e.order_id,source:e,idempotencyKey:input.idempotencyKey,settlement,draftSaleId:draft.saleId})
      :await confirmEngagementDraft(tx,scope,{source:e,draftSaleId:draft.saleId,idempotencyKey:input.idempotencyKey,settlement})
    const linked=await tx.appointmentEngagement.update({where:{id},data:{sale_id:sale.id,version:{increment:1}}})
    await applyEngagementCommitments(tx,scope,linked,sale)
    await require('../../services/accounting/postingEngine').postSaleInTransaction(tx,scope,sale.id)
    await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:e.customer_id,engagement_id:id,actor_id:scope.userId,action:'SALE_ISSUED',request_key:input.idempotencyKey,input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),after:{saleId:sale.id}}})
    return {type:'ENGAGEMENT',id}
  })
}
module.exports={parseSale,issueEngagementSale}
