const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const {createDispute}=require('../src/modules/cash-closure/disputes')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
test('releasing an event advance into a disputed receipt expands the hold before any free credit is published',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db)
    await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'DISABLED'}})
    const engagement=await db.appointmentEngagement.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,source:'QUOTE',currency_code:'GTQ',agreed_total:'100',commercial_snapshot:{},created_by:f.user.id}})
    await db.paymentCommitment.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,engagement_id:engagement.id,payment_id:f.paymentId,amount:'60'}})
    const doc=await db.$transaction(tx=>createDispute(tx,f.scope,{eventId:f.event.id,claimed:'100',providerReference:randomUUID(),reason:'Reclamo del proveedor',requestKey:randomUUID()}))
    const api=require('../src/modules/receivables')
    assert.equal(await api.availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    await assert.rejects(db.paymentCommitment.updateMany({where:{payment_id:f.paymentId},data:{amount:'40'}}),/dispute_receipt_reservation_stale/)
    await db.$transaction(tx=>api.resolveReservedFunds(tx,f.scope,engagement,{action:'RELEASE',receiptId:f.paymentId,amount:'20.00',reason:'Liberación parcial del evento',idempotencyKey:randomUUID()}))
    assert.equal(await api.availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    const [row]=await db.$queryRaw`SELECT held::text FROM customer_receipt_restrictions WHERE dispute_id=${doc.id}::uuid`
    assert.equal(row.held,'60.00')
  }finally{await db.$disconnect()}
})
test('the existing cartera list keeps held advances visible without advertising them as spendable credit',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db)
    await db.$transaction(tx=>createDispute(tx,f.scope,{eventId:f.event.id,claimed:'100',providerReference:randomUUID(),reason:'Reclamo del proveedor',requestKey:randomUUID()}))
    assert.equal((await require('../src/modules/receivables').customerBalance(db,f.customer.id,{branch_id:f.branch.id})).credito_en_revision,100)
    const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/receivables/controller'),async controller=>{
      const res=jsonResponse()
      await controller.list({companyId:f.company.id,branchId:f.branch.id,user:{sub:f.user.id}},res,error=>{throw error})
      assert.equal(res.body.items.length,1)
      assert.equal(res.body.items[0].credito_disponible,0)
      assert.equal(res.body.items[0].credito_en_revision,100)
      assert.equal(res.body.total_credito,0)
      const receipt=jsonResponse()
      await controller.receipt({companyId:f.company.id,branchId:f.branch.id,user:{sub:f.user.id},params:{id:f.paymentId}},receipt,error=>{throw error})
      assert.equal(receipt.body.tiene_disputa,true)
      assert.equal(receipt.body.retenido,100)
      assert.equal(receipt.body.no_aplicado,0)
    })
  }finally{await db.$disconnect()}
})
