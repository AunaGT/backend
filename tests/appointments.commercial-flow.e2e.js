const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb,configureAccounting}=require('./helpers/commercialAgendaFixture.cjs')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const E=require('../src/modules/appointments/engagements'),A=require('../src/modules/appointments/application'),W=require('../src/modules/appointments/activities')
const {collectEngagementPayment}=require('../src/modules/appointments/engagementPayments'),{issueEngagementSale}=require('../src/modules/appointments/engagementSales'),{resolveEngagementFunds}=require('../src/modules/appointments/engagementResolution')
const key=()=>crypto.randomUUID()
async function theoretical(db,scope,session){
  return withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/cash-closure/controller'),async controller=>{
    const res=jsonResponse();await controller.calculateTheoretical({companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,role_name:'admin'},query:{cashier_id:scope.userId,cash_register_session_id:session.id}},res,e=>{throw e})
    assert.equal(res.statusCode,200);return res.body.theoretical.net_total
  })
}
test('accepted mixed quote → program → advance → reschedule → perform → one sale → settle: one conserved financial circuit',async t=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const accounts=await configureAccounting(db,scope,{full:true})
  const locationId=await require('../src/services/stockLocations').defaultLocationId(db,scope.branchId)
  await db.productStockLocation.create({data:{product_id:f.goodsId,location_id:locationId,stock:10}});await db.productStock.create({data:{product_id:f.goodsId,branch_id:scope.branchId,stock:10}});await db.product.update({where:{id:f.goodsId},data:{stock:10}})
  await db.commercialDocument.update({where:{id:f.quoteId},data:{status:'DRAFT'}})
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/quotes/controller'),async controller=>{
    for(const status of ['SENT','ACCEPTED']){const res=jsonResponse();await controller.updateStatus({companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,role_name:'admin'},params:{id:f.quoteId},body:{status}},res,e=>{throw e});assert.equal(res.body.status,status)}
  })
  const e=await E.createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:key()}),appointment=e.lines.find(l=>l.productId===f.productId),work=e.lines.find(l=>l.productId===f.workProductId),workStart=new Date(new Date(f.individualInput.startsAt).getTime()+5400000)
  const scheduled=await E.programEngagement(db,scope,e.id,{expectedVersion:e.version,partial:false,idempotencyKey:key(),programs:[
    {lineId:appointment.id,quantity:'1',startsAt:f.individualInput.startsAt,timezone:'America/Guatemala',providerIds:[f.providerId],acknowledgedConditionsVersion:appointment.conditionsVersion},
    {lineId:work.id,quantity:'1',startsAt:workStart.toISOString(),endsAt:new Date(workStart.getTime()+3600000).toISOString(),timezone:'America/Guatemala',acknowledgedConditionsVersion:work.conditionsVersion,venue:{kind:'EVENT_VENUE',name:'Evento QA',address:'Dirección sintética'},organizerId:scope.userId}
  ]})
  const cash=await db.paymentMethod.create({data:{name:'Efectivo'}}),register=await db.cashRegister.create({data:{branch_id:scope.branchId,name:'Caja del recorrido QA',code:'FLOW'}})
  const open=()=>db.cashRegisterSession.create({data:{cash_register_id:register.id,opened_by_id:scope.userId,opening_float:0,opened_at:new Date(Date.now()-1000)}})
  const turnA=await open(),firstInput={amount:'40.00',paymentMethodId:cash.id,currencyCode:'GTQ',cashRegisterSessionId:turnA.id,paidAt:new Date().toISOString(),expectedVersion:scheduled.version,idempotencyKey:key()}
  const received=await collectEngagementPayment(db,scope,e.id,firstInput)
  assert.equal((await collectEngagementPayment(db,scope,e.id,firstInput)).receiptId,received.receiptId)
  assert.equal(await require('../src/modules/receivables').availableCredit(db,f.contactId,{branch_id:scope.branchId}),0);assert.equal(await db.salePaymentEntry.count({where:{sale_id:f.priorSale.id}}),0)
  await db.cashRegisterSession.update({where:{id:turnA.id},data:{status:'CLOSED',closed_at:new Date()}})
  const bookingId=scheduled.lines.find(l=>l.id===appointment.id).schedules[0].bookingId,booking=await A.loadBooking(db,scope,bookingId),movedAt=new Date(new Date(f.individualInput.startsAt).getTime()+900000)
  let moved=await A.rescheduleBooking(db,scope,bookingId,{startsAt:movedAt.toISOString(),timezone:'America/Guatemala',providerIds:[f.providerId],resourceIds:[],expectedVersion:booking.version,reason:'Horario acordado con cliente',idempotencyKey:key()})
  t.mock.timers.enable({apis:['Date'],now:movedAt.getTime()+60000})
  for(const action of ['ARRIVE','START','COMPLETE'])moved=await A.transitionBooking(db,scope,bookingId,{action,expectedVersion:moved.version,reason:'Atención verificada',idempotencyKey:key()})
  const activityId=scheduled.lines.find(l=>l.id===work.id).schedules[0].sessionId
  t.mock.timers.setTime(workStart.getTime()+60000)
  let activity=await W.getActivity(db,scope,activityId)
  for(const action of ['START','COMPLETE'])activity=await W.transitionActivity(db,scope,activityId,{action,expectedVersion:activity.version,reason:'Evento verificado',idempotencyKey:key()})
  let current=await E.getEngagement(db,scope,e.id);assert.equal(current.operationalState,'COMPLETED');assert.equal(current.money.committed,'40.00')
  const turnB=await open(),saleInput={...f.saleTerms,confirmGoodsDispatch:true,expectedVersion:current.version,idempotencyKey:key()}
  current=await issueEngagementSale(db,scope,e.id,saleInput);assert.equal(current.money.applied,'40.00');assert.equal(current.money.remaining,'135.00')
  assert.equal((await issueEngagementSale(db,scope,e.id,saleInput)).saleId,current.saleId)
  assert.equal((await issueEngagementSale(db,scope,e.id,{...saleInput,expectedVersion:current.version,idempotencyKey:key()})).saleId,current.saleId)
  const finalInput={...firstInput,amount:'135.00',cashRegisterSessionId:turnB.id,paidAt:new Date().toISOString(),expectedVersion:current.version,idempotencyKey:key()}
  current=(await collectEngagementPayment(db,scope,e.id,finalInput)).engagement
  await collectEngagementPayment(db,scope,e.id,finalInput)
  assert.equal(current.money.remaining,'0.00');assert.equal(current.money.applied,'175.00');assert.equal(current.money.committed,'0.00')
  assert.equal(await db.sale.count({where:{settlement_source:'ENGAGEMENT_RECEIPTS'}}),1);assert.equal(await db.customerPayment.count({where:{customer_id:f.contactId}}),2)
  assert.equal(await db.paymentCommitment.count({where:{engagement_id:e.id,state:'COMMITTED'}}),0);assert.equal(await db.salePaymentEntry.count({where:{sale_id:current.saleId}}),2)
  assert.equal(await db.salePaymentEntry.count({where:{sale_id:f.priorSale.id}}),0);assert.equal(await require('../src/modules/receivables').availableCredit(db,f.contactId,{branch_id:scope.branchId}),0)
  assert.equal((await db.productStockLocation.findUnique({where:{product_id_location_id:{product_id:f.goodsId,location_id:locationId}}})).stock,9)
  assert.equal(await db.stockMovement.count({where:{product_id:f.goodsId}}),1);assert.equal(await db.stockMovement.count({where:{product_id:{in:[f.productId,f.workProductId]}}}),0)
  assert.equal(await db.journalEntry.count({where:{source_type:'CUSTOMER_ADVANCE'}}),2);assert.equal(await db.journalEntry.count({where:{source_type:'CUSTOMER_ADVANCE_APPLIED'}}),2);assert.equal(await db.journalEntry.count({where:{source_type:'SALE',source_id:current.saleId}}),1)
  assert.equal(await db.journalEntry.count({where:{source_type:'SALE_PAYMENT'}}),0)
  const cashLines=await db.journalLine.findMany({where:{account_id:accounts.cash.id}});assert.equal(cashLines.reduce((n,l)=>n+Number(l.debit)-Number(l.credit),0),175)
  await db.cashRegisterSession.update({where:{id:turnB.id},data:{status:'CLOSED',closed_at:new Date()}})
  assert.equal(await theoretical(db,scope,turnA),40);assert.equal(await theoretical(db,scope,turnB),135)
}))
test('cancelling the service preserves the source and returns its actual advance, without a sale or new receipt',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await configureAccounting(db,scope)
  let e=await f.cancelledPaidEngagement('40.00')
  const p={...f.refundInput,action:'CONFIRM_REFUND',expectedVersion:e.version,idempotencyKey:key(),paymentMethodId:f.method.id,reference:'Reintegro parcial QA'}
  e=await resolveEngagementFunds(db,scope,e.id,p)
  e=await resolveEngagementFunds(db,scope,e.id,{action:'REQUEST_REFUND',amount:'30.00',receiptId:p.receiptId,reason:'Devolución del resto del anticipo',expectedVersion:e.version,idempotencyKey:key()})
  const pending=await db.customerPaymentRefund.findFirst({where:{engagement_id:e.id,status:'REQUESTED'}}),last={...p,amount:'30.00',refundId:pending.id,expectedVersion:e.version,idempotencyKey:key()}
  e=await resolveEngagementFunds(db,scope,e.id,last);await resolveEngagementFunds(db,scope,e.id,last)
  assert.equal(e.money.refunded,'40.00');assert.equal(e.money.committed,'0.00');assert.equal((await db.customerPayment.findUnique({where:{id:p.receiptId}})).amount.toFixed(2),'40.00')
  assert.equal(await db.customerPayment.count(),1);assert.equal(await db.sale.count({where:{settlement_source:'ENGAGEMENT_RECEIPTS'}}),0);assert.equal(await db.customerPaymentRefund.count({where:{status:'CONFIRMED'}}),2)
  assert.equal(await db.journalEntry.count({where:{source_type:'CUSTOMER_ADVANCE'}}),1);assert.equal(await db.journalEntry.count({where:{source_type:'CUSTOMER_PAYMENT_REFUND'}}),2)
  assert.equal((await db.commercialDocument.findUnique({where:{id:f.quoteId}})).total.toFixed(2),'175.00');assert.equal(await require('../src/modules/receivables').availableCredit(db,f.contactId,{branch_id:scope.branchId}),0)
}))
