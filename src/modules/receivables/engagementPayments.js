const {Prisma}=require('@prisma/client')
const {isCashMethod}=require('../../services/paymentMethods/behavior')
const {createHash}=require('node:crypto')
const {money,allocationForReceipt,allocationSelect}=require('./domain/paymentAllocations')
const {lockCustomer,syncSaleStatus,ReceivableError}=require('./domain/receivables')
const {resolveEffectiveModules}=require('../platform/registry')
function fail(code,message,status=400){throw Object.assign(new ReceivableError(message,status),{code})}
async function engagementCurrencyReason(db,scope,engagement){
  const currency=await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'currency_code'}}})
  const current=currency?.value||'GTQ'
  return current===engagement.currency_code?'':`La contratación usa ${engagement.currency_code} y la empresa ${current}. Revisa las monedas antes de cobrar, vender o devolver; no se convierten automáticamente.`
}
async function engagementMoney(tx,engagement){
  const [committed,applied,refunded,sale,returned]=await Promise.all([
    tx.paymentCommitment.aggregate({where:{engagement_id:engagement.id,state:'COMMITTED'},_sum:{amount:true}}),
    engagement.sale_id?tx.salePaymentEntry.aggregate({where:{sale_id:engagement.sale_id},_sum:{amount:true}}):{_sum:{amount:null}},
    tx.customerPaymentRefund.aggregate({where:{engagement_id:engagement.id,status:'CONFIRMED'},_sum:{amount:true}}),
    engagement.sale_id?tx.sale.findUnique({where:{id:engagement.sale_id},select:{adjusted_total:true}}):null,
    tx.paymentAllocationEvent.aggregate({where:{engagement_id:engagement.id,action:'SALE_REFUNDED'},_sum:{amount:true}})
  ])
  const total=money(sale?.adjusted_total||engagement.agreed_total),reserved=money(committed._sum.amount||'0'),paid=money(applied._sum.amount||'0'),refundTotal=money(refunded._sum.amount||'0').add(money(returned._sum.amount||'0'))
  return {currencyCode:engagement.currency_code,agreedTotal:money(engagement.agreed_total).toFixed(2),total:total.toFixed(2),committed:reserved.toFixed(2),applied:paid.toFixed(2),refunded:refundTotal.toFixed(2),remaining:Prisma.Decimal.max(0,total.sub(reserved).sub(paid)).toFixed(2)}
}
async function postMovement(tx,scope,movement){
  const modules=resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(modules.find(m=>m.code==='accounting')?.effectiveEnabled)await require('../../services/accounting/engagementPosting').postEngagementMovement(tx,scope,movement)
}
function allocationData(scope,engagement,receipt,commitment,input,action,amount){
  return {company_id:scope.companyId,branch_id:engagement.branch_id,customer_id:engagement.customer_id,engagement_id:engagement.id,payment_id:receipt.id,commitment_id:commitment.id,
    action,amount,request_key:input.idempotencyKey,input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),actor_id:scope.userId,reason:input.reason||''}
}
async function createScopedReceipt(tx,scope,engagement,input){
  const amount=money(input.amount)
  if(amount.lte(0))fail('INVALID_MONEY','El pago debe ser mayor que cero')
  if(engagement.branch_id!==scope.branchId||engagement.company_id!==scope.companyId)fail('FORBIDDEN','La contratación pertenece a otro alcance',403)
  const customer=await tx.supplier.findFirst({where:{id:engagement.customer_id,company_id:scope.companyId,party_type:'CUSTOMER',deleted:false,estado:1},select:{id:true}})
  if(!customer)fail('INVALID_CONTACT','El cliente ya no está activo en esta empresa')
  if(input.currencyCode!==engagement.currency_code||await engagementCurrencyReason(tx,scope,engagement))fail('CURRENCY_MISMATCH','La moneda del pago debe coincidir con la contratación y la empresa')
  const balance=await engagementMoney(tx,engagement)
  if(amount.gt(balance.remaining))fail('PAYMENT_EXCEEDS_BALANCE','El pago supera el saldo pendiente de esta contratación',409)
  if(await tx.customerPaymentRefund.count({where:{engagement_id:engagement.id,status:'REQUESTED'}}))fail('REFUND_PENDING','Resuelve la devolución pendiente antes de recibir otro pago',409)
  const method=await validateScopedMethod(tx,scope,input)
  return tx.customerPayment.create({data:{branch_id:engagement.branch_id,customer_id:engagement.customer_id,amount,paid_at:new Date(input.paidAt),payment_method_id:method.id,
    cash_register_session_id:input.cashRegisterSessionId||null,reference:input.reference||null,notes:input.notes||null,registered_by:scope.userId}})
}
async function validateScopedMethod(tx,scope,input,purpose='RECEIPT'){
  const method=await require('../../services/paymentMethods/access').resolvePaymentMethod(tx,{companyId:scope.companyId,methodId:input.paymentMethodId,purpose})
  const cash=isCashMethod(method,name=>/efectivo|cash/.test(name.toLowerCase().normalize('NFD').replace(/\p{M}/gu,'')))
  if(cash&&!input.cashRegisterSessionId)fail('CASH_SESSION_REQUIRED','Abre un turno de caja antes de recibir efectivo')
  if(input.cashRegisterSessionId){
    await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id=${input.cashRegisterSessionId}::uuid FOR UPDATE`
    const session=await tx.cashRegisterSession.findFirst({where:{id:input.cashRegisterSessionId,cashRegister:{branch_id:scope.branchId,active:true}},select:{id:true,status:true,opened_by_id:true,opened_at:true}})
    if(!session||session.status!=='OPEN')fail('CASH_SESSION_CLOSED','El turno no está abierto en esta sucursal',409)
    if(!scope.isAdmin&&session.opened_by_id!==scope.userId)fail('FORBIDDEN','Solo puedes recibir efectivo en tu propio turno',403)
    if(new Date(input.paidAt)<session.opened_at)fail('INVALID_PAYMENT_DATE','El pago no puede ser anterior a la apertura del turno')
  }
  return method
}
async function commitReceiptToEngagement(tx,scope,engagement,receipt,input){
  const commitment=await tx.paymentCommitment.create({data:{company_id:scope.companyId,branch_id:engagement.branch_id,customer_id:engagement.customer_id,engagement_id:engagement.id,payment_id:receipt.id,amount:receipt.amount}})
  const event=await tx.paymentAllocationEvent.create({data:allocationData(scope,engagement,receipt,commitment,input,'COMMITTED',receipt.amount)})
  await postMovement(tx,scope,{kind:'RECEIVE',id:receipt.id,engagementId:engagement.id,paymentId:receipt.id,amount:receipt.amount.toFixed(2),date:receipt.paid_at,paymentMethodId:receipt.payment_method_id,cashRegisterSessionId:receipt.cash_register_session_id,reference:receipt.reference})
  return {commitment,event}
}
async function applyReceiptToEngagementSale(tx,scope,engagement,receipt,commitment,input){
  const sale=await tx.sale.findFirst({where:{id:engagement.sale_id,branch_id:engagement.branch_id,customer_contact_id:engagement.customer_id,status:{name:'Completada'}},include:{paymentEntries:true}})
  if(!sale)fail('INVALID_SALE','La venta vinculada no corresponde al cliente y sucursal',409)
  const paid=sale.paymentEntries.reduce((sum,row)=>sum.add(row.amount),new Prisma.Decimal(0))
  const amount=money(commitment.amount)
  if(paid.add(amount).gt(sale.adjusted_total))fail('PAYMENT_EXCEEDS_BALANCE','El anticipo excede el saldo de la venta',409)
  const entry=await tx.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:receipt.id,amount}})
  await tx.paymentCommitment.update({where:{id:commitment.id},data:{state:'APPLIED',version:{increment:1}}})
  const event=await tx.paymentAllocationEvent.create({data:allocationData(scope,engagement,receipt,commitment,input,'APPLIED',amount)})
  await syncSaleStatus(tx,sale.id)
  await postMovement(tx,scope,{kind:'APPLY',id:event.id,engagementId:engagement.id,paymentId:receipt.id,saleId:sale.id,amount:amount.toFixed(2),date:new Date(),reference:receipt.reference})
  return entry
}
async function receiveEngagementPayment(tx,scope,engagement,input){
  await lockCustomer(tx,engagement.customer_id)
  const receipt=await createScopedReceipt(tx,scope,engagement,input)
  const {commitment}=await commitReceiptToEngagement(tx,scope,engagement,receipt,input)
  if(engagement.sale_id)await applyReceiptToEngagementSale(tx,scope,engagement,receipt,commitment,input)
  allocationForReceipt(await tx.customerPayment.findUnique({where:{id:receipt.id},select:{amount:true,...allocationSelect}}))
  return receipt
}
async function applyEngagementCommitments(tx,scope,engagement,sale){
  await lockCustomer(tx,engagement.customer_id)
  if(sale.id!==engagement.sale_id||sale.branch_id!==engagement.branch_id||sale.customer_contact_id!==engagement.customer_id)fail('INVALID_SALE','La venta no corresponde a esta contratación',409)
  const pending=await tx.paymentCommitment.findMany({where:{engagement_id:engagement.id,state:'COMMITTED'},include:{payment:true},orderBy:{created_at:'asc'}})
  const ids=[];let amount=new Prisma.Decimal(0)
  for(const c of pending){const entry=await applyReceiptToEngagementSale(tx,scope,engagement,c.payment,c,{idempotencyKey:`apply-${sale.id}`});ids.push(entry.id);amount=amount.add(c.amount)}
  return {applied:amount.toFixed(2),allocationIds:ids}
}
async function reservedReceipt(tx,scope,engagement,input){
  const c=await tx.paymentCommitment.findFirst({where:{company_id:scope.companyId,branch_id:engagement.branch_id,customer_id:engagement.customer_id,engagement_id:engagement.id,payment_id:input.receiptId,state:'COMMITTED'},include:{payment:true}})
  if(!c)fail('RECEIPT_NOT_RESERVED','El recibo ya no tiene dinero comprometido en esta contratación',409)
  const amount=money(input.amount)
  if(amount.gt(c.amount))fail('REFUND_EXCEEDS_RESERVED','El importe supera el dinero todavía comprometido',409)
  return c
}
async function decreaseCommitment(tx,c,amount,finalState){
  const remaining=c.amount.sub(amount)
  return tx.paymentCommitment.update({where:{id:c.id},data:{...(remaining.gt(0)?{amount:remaining}:{state:finalState}),version:{increment:1}}})
}
async function confirmScopedRefund(tx,scope,engagement,input){
  const currencyReason=await engagementCurrencyReason(tx,scope,engagement)
  if(currencyReason)fail('CURRENCY_MISMATCH',currencyReason,409)
  const refund=await tx.customerPaymentRefund.findFirst({where:{id:input.refundId,company_id:scope.companyId,branch_id:engagement.branch_id,customer_id:engagement.customer_id,engagement_id:engagement.id,payment_id:input.receiptId}})
  if(!refund||refund.status!=='REQUESTED'||!refund.amount.eq(input.amount))fail('REFUND_NOT_PENDING','Selecciona la solicitud pendiente y su importe original',409)
  const c=await reservedReceipt(tx,scope,engagement,input),now=new Date()
  const method=await validateScopedMethod(tx,scope,{...input,paidAt:now.toISOString()},'REFUND')
  if(!isCashMethod(method,name=>/efectivo|cash/i.test(name))&&!input.reference)fail('REFUND_REFERENCE_REQUIRED','Registra la referencia real del reintegro')
  const effective=await tx.customerPaymentRefund.update({where:{id:refund.id},data:{status:'CONFIRMED',confirmed_at:now,confirmed_key:input.idempotencyKey,payment_method_id:method.id,cash_register_session_id:input.cashRegisterSessionId||null,reference:input.reference||'',registered_by:scope.userId}})
  await decreaseCommitment(tx,c,refund.amount,'REFUNDED')
  await tx.paymentAllocationEvent.create({data:allocationData(scope,engagement,c.payment,c,input,'REFUNDED',refund.amount)})
  await postMovement(tx,scope,{kind:'REFUND',id:effective.id})
  return effective
}
async function resolveReservedFunds(tx,scope,engagement,input){
  if(input.action==='RELEASE'){
    const currencyReason=await engagementCurrencyReason(tx,scope,engagement)
    if(currencyReason)fail('CURRENCY_MISMATCH',currencyReason,409)
  }
  await lockCustomer(tx,engagement.customer_id)
  if(engagement.sale_id)fail('USE_SALE_RETURN','Usa Devoluciones para el dinero de una venta emitida',409)
  if(input.action==='CONFIRM_REFUND')await confirmScopedRefund(tx,scope,engagement,input)
  else if(input.action==='CANCEL_REFUND'){
    const refund=await tx.customerPaymentRefund.findFirst({where:{id:input.refundId,company_id:scope.companyId,engagement_id:engagement.id,payment_id:input.receiptId,status:'REQUESTED'}})
    if(!refund||!refund.amount.eq(input.amount))fail('REFUND_NOT_PENDING','Selecciona una solicitud pendiente válida',409)
    await tx.customerPaymentRefund.update({where:{id:refund.id},data:{status:'CANCELLED'}})
  }else{
    const c=await reservedReceipt(tx,scope,engagement,input)
    if(await tx.customerPaymentRefund.count({where:{payment_id:input.receiptId,engagement_id:engagement.id,status:'REQUESTED'}}))fail('REFUND_PENDING','Resuelve primero la solicitud de devolución pendiente',409)
    if(input.action==='REQUEST_REFUND')await tx.customerPaymentRefund.create({data:{company_id:scope.companyId,branch_id:engagement.branch_id,customer_id:engagement.customer_id,engagement_id:engagement.id,payment_id:input.receiptId,amount:input.amount,reason:input.reason,request_key:input.idempotencyKey,input_hash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),registered_by:scope.userId}})
    else if(input.action==='RELEASE'){
      await decreaseCommitment(tx,c,money(input.amount),'RELEASED')
      const event=await tx.paymentAllocationEvent.create({data:allocationData(scope,engagement,c.payment,c,input,'RELEASED',input.amount)})
      await postMovement(tx,scope,{kind:'APPLY',id:event.id})
    }else fail('INVALID_INPUT','Resolución inválida')
  }
  allocationForReceipt(await tx.customerPayment.findUnique({where:{id:input.receiptId},select:{amount:true,...allocationSelect}}))
}
async function releaseEngagementSaleOverpayment(tx,e,saleId,rawAmount,resolution){
  await lockCustomer(tx,e.customer_id)
  const settlement=await tx.returnSettlement.findFirst({where:{id:resolution.returnSettlementId,return:{sale_id:saleId,sale:{branch_id:e.branch_id,customer_contact_id:e.customer_id,branch:{company_id:e.company_id}}}}})
  if(!settlement||!['REFUND','CUSTOMER_CREDIT'].includes(settlement.kind)||!settlement.amount.eq(String(rawAmount)))fail('ENGAGEMENT_RESOLUTION_REQUIRED','Selecciona la devolución autorizada que resuelve este excedente',409)
  if(settlement.kind==='REFUND'&&!settlement.payment_method_id)fail('INVALID_PAYMENT_METHOD','El reintegro necesita su medio real')
  const entries=await tx.salePaymentEntry.findMany({where:{sale_id:saleId},orderBy:[{created_at:'desc'},{id:'asc'}]})
  let remaining=money(String(rawAmount));const released=new Map()
  for(const entry of entries){
    if(remaining.eq(0))break
    const take=Prisma.Decimal.min(remaining,entry.amount),left=entry.amount.sub(take)
    if(left.eq(0))await tx.salePaymentEntry.delete({where:{id:entry.id}})
    else await tx.salePaymentEntry.update({where:{id:entry.id},data:{amount:left}})
    released.set(entry.customer_payment_id,(released.get(entry.customer_payment_id)||new Prisma.Decimal(0)).add(take))
    remaining=remaining.sub(take)
  }
  if(remaining.gt(0))fail('PAYMENT_ALLOCATION_CONFLICT','El reintegro excede las aplicaciones vigentes',409)
  const key=`sale-return:${settlement.id}`,hash=createHash('sha256').update(JSON.stringify({saleId,amount:String(rawAmount),settlementId:settlement.id})).digest('hex')
  for(const [paymentId,amount] of released){
    const commitment=await tx.paymentCommitment.findFirst({where:{engagement_id:e.id,payment_id:paymentId}})
    await tx.paymentAllocationEvent.create({data:{company_id:e.company_id,branch_id:e.branch_id,customer_id:e.customer_id,engagement_id:e.id,payment_id:paymentId,commitment_id:commitment?.id||null,return_settlement_id:settlement.id,action:settlement.kind==='REFUND'?'SALE_REFUNDED':'SALE_RELEASED',amount,actor_id:resolution.userId,reason:resolution.reason||'Corrección de venta',request_key:key,input_hash:hash}})
    allocationForReceipt(await tx.customerPayment.findUnique({where:{id:paymentId},select:{amount:true,...allocationSelect}}))
  }
  await syncSaleStatus(tx,saleId)
  await tx.appointmentEngagement.update({where:{id:e.id},data:{version:{increment:1}}})
  await tx.appointmentEngagementHistory.create({data:{company_id:e.company_id,branch_id:e.branch_id,customer_id:e.customer_id,engagement_id:e.id,actor_id:resolution.userId,action:'SALE_RETURN',reason:resolution.reason||'Corrección de venta',request_key:key,input_hash:hash,after:{returnSettlementId:settlement.id,amount:String(rawAmount),resolution:settlement.kind}}})
  return money(String(rawAmount)).toNumber()
}
module.exports={receiveEngagementPayment,applyEngagementCommitments,engagementMoney,engagementCurrencyReason,createScopedReceipt,commitReceiptToEngagement,applyReceiptToEngagementSale,resolveReservedFunds,confirmScopedRefund,releaseEngagementSaleOverpayment}
