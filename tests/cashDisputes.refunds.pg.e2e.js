const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL

async function returnFixture(db,f,amount='40',deferSettlement=false) {
  const status=await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
  const credit=await db.paymentMethod.create({data:{company_id:f.company.id,name:'Crédito QA',is_credit:true}})
  const sale=await db.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:status.id,payment_method_id:credit.id,total:100,adjusted_total:100,items:0,created_by:f.user.id}})
  const rs=await db.returnStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
  const returned=await db.return.create({data:{sale_id:sale.id,status_id:rs.id,total_refund:amount}})
  const settlement=deferSettlement?null:await db.returnSettlement.create({data:{return_id:returned.id,kind:'REFUND',amount,registered_by:f.user.id,idempotency_key:randomUUID()}})
  return {sale,settlement,returned}
}

test('a regular credit-sale refund stays attributed to its original receipt and cannot become available again',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),{sale,settlement}=await returnFixture(db,f)
    await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:f.paymentId,amount:'100'}})
    const receipts=require('../src/modules/receivables'),refunds=require('../src/modules/cash-closure/disputes.refunds')
    await db.$transaction(async tx=>{
      const result=await receipts.releaseSaleOverpaymentWithPlan(tx,sale.id,40)
      assert.deepEqual(result.allocations,[{paymentId:f.paymentId,amount:'40.00'}])
      await refunds.recordReturnAllocations(tx,f.scope,settlement.id,result.allocations)
    })
    assert.equal(await receipts.availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    const ctx=await require('../src/modules/cash-closure/disputes.queries').originContext(db,f.scope,f.event.id)
    assert.equal(ctx.effectiveRefunded,'40.00');assert.equal(ctx.claimable,'60.00');assert.equal(ctx.eligible,true)
    const [row]=await db.$queryRaw`SELECT * FROM cash_refund_allocations WHERE source_id=${settlement.id}::uuid`
    await assert.rejects(db.$executeRaw`UPDATE cash_refund_allocations SET amount=1 WHERE id=${row.id}::uuid`,/dispute_immutable/)
    await assert.rejects(db.returnSettlement.update({where:{id:settlement.id},data:{amount:'1'}}),/refund_source_immutable/)
    await assert.rejects(db.$transaction(tx=>refunds.recordReturnAllocations(tx,f.scope,settlement.id,[{paymentId:f.paymentId,amount:'1.00'}])),/refund_source_budget/)
    const other=await fixture(db)
    await assert.rejects(db.$transaction(tx=>refunds.recordReturnAllocations(tx,other.scope,settlement.id,[{paymentId:f.paymentId,amount:'1.00'}])),{status:404})
  } finally {await db.$disconnect()}
})

for(const first of ['REFUND','CLAIM'])test(`a concurrent refund and claim share one origin budget when ${first} gets the lock first`,{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),{sale,returned}=await returnFixture(db,f,'40',true)
    await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:f.paymentId,amount:'100'}})
    const refunds=require('../src/modules/cash-closure/disputes.refunds'),receipts=require('../src/modules/receivables')
    let ready,release
    const locked=new Promise(resolve=>{ready=resolve}),gate=new Promise(resolve=>{release=resolve})
    const run=kind=>db.$transaction(async tx=>{
      if(kind==='REFUND') {
        await refunds.prepareSaleRefundMutation(tx,f.scope,sale.id)
        if(first===kind){ready();await gate}
        await tx.$queryRaw`SELECT id FROM sales WHERE id=${sale.id}::uuid FOR UPDATE`
        const rs=await tx.returnSettlement.create({data:{return_id:returned.id,kind:'REFUND',amount:'40',registered_by:f.user.id,idempotency_key:randomUUID()}})
        const result=await receipts.releaseSaleOverpaymentWithPlan(tx,sale.id,40)
        await refunds.recordReturnAllocations(tx,f.scope,rs.id,result.allocations)
        return rs
      }
      const doc=await require('../src/modules/cash-closure/disputes').createDispute(tx,f.scope,{eventId:f.event.id,claimed:'100',providerReference:randomUUID(),reason:'Reclamo concurrente QA',requestKey:randomUUID()})
      if(first===kind){ready();await gate}
      return doc
    },{timeout:30000})
    const firstRun=run(first)
    await Promise.race([locked,firstRun.then(()=>assert.fail('The first transaction must wait at its barrier'))])
    const secondRun=run(first==='REFUND'?'CLAIM':'REFUND')
    release()
    const results=await Promise.allSettled([firstRun,secondRun])
    assert.equal(results[0].status,'fulfilled')
    assert.equal(results[1].status,'rejected')
    assert.equal(results[1].reason.code,first==='REFUND'?'DISPUTE_COVERAGE_EXCEEDED':'DISPUTE_REFUND_RESTRICTED')
    assert.equal(await db.cashPaymentDispute.count(),first==='CLAIM'?1:0)
    assert.equal(await db.cashRefundAllocation.count(),first==='REFUND'?1:0)
    assert.equal(await receipts.availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
  } finally {await db.$disconnect()}
})

test('database coverage rejects a legacy writer refunding principal still occupied by a pending claim',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),{sale,settlement}=await returnFixture(db,f)
    await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:f.paymentId,amount:'100'}})
    await require('./helpers/cashDisputesQa.cjs').insertCase(db,f)
    await assert.rejects(db.$transaction(async tx=>{
      await tx.salePaymentEntry.updateMany({where:{customer_payment_id:f.paymentId},data:{amount:'60'}})
      await tx.$executeRaw`INSERT INTO cash_refund_allocations(company_id,branch_id,customer_id,payment_id,origin_event_id,source_type,source_id,action,amount,actor_id)
        VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${f.customer.id}::uuid,${f.paymentId}::uuid,${f.event.id}::uuid,'RETURN_SETTLEMENT',${settlement.id}::uuid,'REFUND',40,${f.user.id}::uuid)`
    }),/dispute_coverage/)
    assert.equal(await db.cashRefundAllocation.count(),0)
    assert.equal(String((await db.salePaymentEntry.findFirst({where:{customer_payment_id:f.paymentId}})).amount),'100')
  } finally {await db.$disconnect()}
})

test('attributing a confirmed engagement refund does not count its existing money source twice',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db)
    const e=await db.appointmentEngagement.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,source:'QUOTE',currency_code:'GTQ',agreed_total:'100',commercial_snapshot:{},created_by:f.user.id}})
    await db.paymentCommitment.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,engagement_id:e.id,payment_id:f.paymentId,amount:'100'}})
    await db.$transaction(async tx=>{
      const refund=await tx.customerPaymentRefund.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,engagement_id:e.id,payment_id:f.paymentId,amount:'40',status:'CONFIRMED',reason:'Devolución manual QA',request_key:randomUUID(),input_hash:'a'.repeat(64),registered_by:f.user.id}})
      await tx.paymentCommitment.updateMany({where:{payment_id:f.paymentId},data:{amount:'60'}})
      await require('../src/modules/cash-closure/disputes.refunds').recordConfirmedReceiptRefund(tx,f.scope,refund)
    })
    assert.equal(await require('../src/modules/receivables').availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    const [row]=await db.$queryRaw`SELECT cash_dispute_receipt_refunded(${f.paymentId}::uuid)::text AS refunded`
    assert.equal(row.refunded,'40.00')
  } finally {await db.$disconnect()}
})

test('completing and retrying a real regular credit-sale return creates one refund and no reusable credit',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),{sale,returned}=await returnFixture(db,f,'40',true)
    const category=await db.productCategory.create({data:{company_id:f.company.id,name:'Servicios QA'}})
    const status=await db.stockStatus.upsert({where:{name:'Disponible QA'},create:{name:'Disponible QA'},update:{}})
    const product=await db.product.create({data:{company_id:f.company.id,category_id:category.id,status_id:status.id,name:'Servicio QA',kind:'SERVICE',service_unit_label:'Servicio',quantity_decimals:0,price:100,cost:0}})
    const item=await db.saleItem.create({data:{sale_id:sale.id,product_id:product.id,price:100,unit_cost:0,net_total:100,qty:1,item_name:product.name,item_kind:'SERVICE',unit_label:'Servicio'}})
    const approved=await db.returnStatus.upsert({where:{name:'Aprobada'},create:{name:'Aprobada'},update:{}})
    await db.return.update({where:{id:returned.id},data:{status_id:approved.id,approved_resolution:'REFUND_TRANSFER',return_items:{create:{sale_item_id:item.id,product_id:product.id,qty_returned:1,refund_amount:40}}}})
    const line=await db.returnItem.findFirst({where:{return_id:returned.id}})
    await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:f.paymentId,amount:'100'}})
    const params={id:returned.id,scope:{branch_id:f.branch.id,branch:{company_id:f.company.id}},companyId:f.company.id,userId:f.user.id,permissions:['returns.complete'],
      payload:{idempotency_key:randomUUID(),lines:[{return_item_id:line.id}],settlement:{payment_method_id:f.card.id,cash_register_session_id:f.period.id,external_reference:'QA-REINTEGRO'}}}
    const complete=()=>require('../src/modules/returns/application').completeReturn(db,params)
    const result=await complete(),retry=await complete()
    assert.equal(result.status.name,'Completada');assert.equal(retry._idempotent,true)
    assert.equal(result._settlement.id,retry._settlement.id)
    assert.equal(await db.cashRefundAllocation.count(),1)
    assert.equal(await require('../src/modules/receivables').availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    const events=await db.$queryRaw`SELECT source_type,amount::text AS amount FROM cash_money_events WHERE source_id=${result._settlement.id}::uuid`
    assert.deepEqual(events,[{source_type:'RETURN_SETTLEMENT',amount:'40.00'}])
  } finally {await db.$disconnect()}
})

for(const partialTrace of [false,true])test(`a merchant-funded refund with ${partialTrace?'partial existing':'generic'} attribution consumes preserved credit once and a later bank recovery creates no second customer credit`,{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),{sale,settlement}=await returnFixture(db,f)
    await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:f.paymentId,amount:'100'}})
    const {insertCase}=require('./helpers/cashDisputesQa.cjs'),id=await insertCase(db,f)
    await db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',100,'2026-11-23','QA-RETIRO',${f.user.id}::uuid)`
    async function approve(kind,payload,version) {
      const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
        VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${kind},${JSON.stringify(payload)}::jsonb,${'b'.repeat(64)},${version},${f.user.id}::uuid) RETURNING id`
      await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`
      return p.id
    }
    await approve('RESULT',{won:'0.00',lost:'100.00'},1)
    await db.$executeRaw`UPDATE cash_payment_disputes SET status='LOST',lost=100,version=2 WHERE id=${id}::uuid`
    const p=await approve('DISPOSITION',{customerPrincipal:'0.00',absorbedPrincipal:'100.00'},2)
    const [lot]=await db.$queryRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,kind,principal) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${p}::uuid,'ABSORBED',100) RETURNING id`
    const receipts=require('../src/modules/receivables'),refunds=require('../src/modules/cash-closure/disputes.refunds')
    const engagement=partialTrace?await db.appointmentEngagement.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,source:'QUOTE',currency_code:'GTQ',agreed_total:'100',commercial_snapshot:{},created_by:f.user.id}}):null
    await db.$transaction(async tx=>{
      const result=await receipts.releaseSaleOverpaymentWithPlan(tx,sale.id,40)
      if(partialTrace)await tx.paymentAllocationEvent.create({data:{company_id:f.company.id,branch_id:f.branch.id,customer_id:f.customer.id,engagement_id:engagement.id,payment_id:f.paymentId,return_settlement_id:settlement.id,action:'SALE_REFUNDED',amount:'10',actor_id:f.user.id,reason:'Traza parcial QA',request_key:randomUUID(),input_hash:'a'.repeat(64)}})
      await refunds.recordReturnAllocations(tx,f.scope,settlement.id,result.allocations)
    })
    const [funded]=await db.$queryRaw`SELECT sum(amount)::text AS amount FROM cash_refund_allocations WHERE funding_lot_id=${lot.id}::uuid`
    assert.equal(funded.amount,'40.00');assert.equal(await receipts.availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    const correction=await approve('CORRECT',{},3)
    await assert.rejects(db.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,target_lot_id,kind,principal) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${correction}::uuid,${lot.id}::uuid,'COMPENSATED',20)`,/refund_funding_descendants/)
    await db.$transaction(async tx=>{
      const [recovery]=await tx.$queryRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_RECOVERY',80,'2026-11-23','QA-RECUPERACION',${f.user.id}::uuid) RETURNING id`
      await tx.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,event_id,target_lot_id,kind,principal) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${recovery.id}::uuid,${lot.id}::uuid,'RECOVERED',80)`
    })
    const ctx=await require('../src/modules/cash-closure/disputes.queries').originContext(db,f.scope,f.event.id)
    assert.equal(ctx.claimable,'60.00');assert.equal(await receipts.availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    assert.equal(await db.customerRecoveryCredit.count(),0)
  } finally {await db.$disconnect()}
})
