const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
const {createEngagement}=require('../src/modules/appointments/engagements')
const {availableCredit,applyAvailableCredit}=require('../src/modules/receivables')
let collectEngagementPayment
try{({collectEngagementPayment}=require('../src/modules/appointments/engagementPayments'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
const input=(f,version,amount='40.00')=>({amount,expectedVersion:version,paymentMethodId:f.method.id,paidAt:new Date().toISOString(),currencyCode:'GTQ',reference:'Pago QA',idempotencyKey:crypto.randomUUID()})
test('a receipt with applied, committed and refunded money exposes only the conserved free balance and never permits historical deletion',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  const e=await createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const received=await collectEngagementPayment(db,scope,e.id,input(f,e.version,'100.00'))
  await db.paymentCommitment.updateMany({where:{payment_id:received.receiptId},data:{amount:60}})
  await db.salePaymentEntry.create({data:{sale_id:f.priorSale.id,customer_payment_id:received.receiptId,amount:30}})
  await db.customerPaymentRefund.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:f.contactId,engagement_id:e.id,payment_id:received.receiptId,amount:5,payment_method_id:f.method.id,status:'CONFIRMED',confirmed_at:new Date(),confirmed_key:crypto.randomUUID(),request_key:crypto.randomUUID(),input_hash:'a'.repeat(64),reason:'QA',registered_by:scope.userId}})
  assert.equal(await availableCredit(db,f.contactId,{branch_id:scope.branchId}),5)
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/receivables/controller'),async controller=>{
    const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId},params:{id:received.receiptId}}
    const response=jsonResponse();await controller.receipt(req,response,error=>{throw error})
    assert.equal(response.body.no_aplicado,5);assert.equal(response.body.comprometido,60);assert.equal(response.body.devuelto,5)
    for(const state of ['APPLIED','RELEASED']){
      await db.paymentCommitment.updateMany({where:{payment_id:received.receiptId},data:{state}})
      let denied;await controller.deletePayment(req,jsonResponse(),error=>{denied=error})
      assert.equal(denied?.code,'PAYMENT_LINKED_TO_ENGAGEMENT')
    }
  })
}))
test('the collection controller rechecks permission, module, currency, method and scoped engagement without writing a receipt',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const e=await createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/appointments/controller'),async controller=>{
    const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,permissions:['appointments.view','appointments.view_team','appointments.collect','receivables.manage','quotes.view']},params:{id:e.id},body:input(f,e.version)}
    for(const [change,status,code] of [
      [{user:{sub:scope.userId,permissions:['appointments.view','appointments.collect']}},403,'FORBIDDEN'],
      [{body:{...req.body,currencyCode:'USD'}},400,'CURRENCY_MISMATCH'],
      [{body:{...req.body,paymentMethodId:f.creditMethod.id}},400,'INVALID_PAYMENT_METHOD'],
      [{params:{id:crypto.randomUUID()}},404,'NOT_FOUND'],
    ]){const res=jsonResponse();await controller.collectEngagementPayment({...req,...change},res,error=>{throw error});assert.equal(res.statusCode,status);assert.equal(res.body.code,code)}
    await db.companyModule.create({data:{company_id:scope.companyId,module_code:'receivables',status:'DISABLED'}})
    const res=jsonResponse();await controller.collectEngagementPayment(req,res,error=>{throw error});assert.equal(res.statusCode,403);assert.equal(res.body.code,'MODULE_DISABLED')
  })
  assert.equal(await db.customerPayment.count(),0)
}))
test('event advances never pay the same customer previous debt or become available to POS credit',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  assert.equal(typeof collectEngagementPayment,'function')
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  const engagement=await createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const paymentInput=input(f,engagement.version)
  const received=await collectEngagementPayment(db,scope,engagement.id,paymentInput)
  assert.equal(received.engagement.money.committed,'40.00')
  assert.equal(received.engagement.commercialReady,true)
  assert.equal(received.engagement.capabilities.collect,true)
  assert.equal(received.engagement.receipts[0].allocation.committed,'40.00')
  assert.equal(received.engagement.receipts[0].amount,'40.00')
  assert.equal(await db.salePaymentEntry.count({where:{customer_payment_id:received.receiptId}}),0)
  assert.equal(await availableCredit(db,f.contactId,{branch_id:scope.branchId}),0)
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/receivables/controller'),async controller=>{
    const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId},params:{id:received.receiptId}}
    let denied
    await controller.deletePayment(req,jsonResponse(),error=>{denied=error})
    assert.equal(denied?.code,'PAYMENT_LINKED_TO_ENGAGEMENT')
    const statement=jsonResponse();await controller.statement({...req,params:{id:f.contactId},query:{}},statement,error=>{throw error})
    assert.equal(statement.body.cobros[0].no_aplicado,0)
    assert.equal(statement.body.cobros[0].comprometido,40)
    const receipt=jsonResponse();await controller.receipt(req,receipt,error=>{throw error})
    assert.equal(receipt.body.no_aplicado,0)
    assert.equal(receipt.body.comprometido,40)
  })
  assert.deepEqual(await db.$transaction(tx=>applyAvailableCredit(tx,f.contactId,scope.branchId)),[])
  const replay=await collectEngagementPayment(db,scope,engagement.id,paymentInput)
  assert.equal(replay.receiptId,received.receiptId);assert.equal(await db.customerPayment.count(),1)
  await assert.rejects(()=>collectEngagementPayment(db,scope,engagement.id,{...paymentInput,amount:'41.00'}),{code:'IDEMPOTENCY_CONFLICT'})
  const competing=await Promise.allSettled([1,2].map(()=>collectEngagementPayment(db,scope,engagement.id,input(f,received.engagement.version,'100.00'))))
  assert.equal(competing.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(await db.customerPayment.count(),2)
  assert.equal(await db.salePaymentEntry.count({where:{sale_id:f.priorSale.id}}),0)
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'receivables',status:'DISABLED'}})
  const disabled=await require('../src/modules/appointments/engagements').getEngagement(db,scope,engagement.id)
  assert.equal(disabled.commercialReady,false);assert.equal(disabled.capabilities.collect,false);assert.match(disabled.capabilities.reason,/habilitados/)
}))
test('a cancelled source quote cannot continue receiving money through an existing engagement',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  const e=await createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  await db.commercialDocument.update({where:{id:f.quoteId},data:{status:'CANCELLED'}})
  await assert.rejects(()=>collectEngagementPayment(db,scope,e.id,input(f,e.version)),{code:'SOURCE_REVIEW_REQUIRED'})
  assert.equal(await db.customerPayment.count(),0)
}))
test('after a linked sale the payment applies only to that sale and remains protected from deletion',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  assert.equal(typeof collectEngagementPayment,'function')
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  const engagement=await createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
  const sale=await db.sale.create({data:{branch_id:scope.branchId,customer_contact_id:f.contactId,total:175,adjusted_total:175,items:3,payment_method_id:f.creditMethod.id,status_id:f.saleStatus.id,payment_status:'PENDING',settlement_source:'ENGAGEMENT_RECEIPTS'}})
  await db.appointmentEngagement.update({where:{id:engagement.id},data:{sale_id:sale.id}})
  const received=await collectEngagementPayment(db,scope,engagement.id,input(f,engagement.version))
  const entries=await db.salePaymentEntry.findMany({where:{customer_payment_id:received.receiptId}})
  assert.equal(entries.length,1);assert.equal(entries[0].sale_id,sale.id)
  assert.equal(received.engagement.money.applied,'40.00');assert.equal(received.engagement.money.remaining,'135.00')
  assert.equal(await availableCredit(db,f.contactId,{branch_id:scope.branchId}),0)
  const {applyPayment}=require('../src/modules/receivables')
  await db.$transaction(tx=>applyPayment(tx,{customerId:f.contactId,branchId:scope.branchId,amount:60,paymentMethodId:f.method.id,userId:scope.userId,manualApplications:[{sale_id:sale.id,amount:60}]}))
  const current=await require('../src/modules/appointments/engagements').getEngagement(db,scope,engagement.id)
  assert.equal(current.money.applied,'100.00')
  assert.equal(current.money.remaining,'75.00')
}))
