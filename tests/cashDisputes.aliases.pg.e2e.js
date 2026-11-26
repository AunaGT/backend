const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL

test('credit notes returned from one bank sale share its dispute hold without multiplying the reserved principal',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db)
    const category=await db.productCategory.create({data:{company_id:f.company.id,name:'Servicios QA'}})
    const status=await db.stockStatus.upsert({where:{name:'Disponible QA'},create:{name:'Disponible QA'},update:{}})
    const product=await db.product.create({data:{company_id:f.company.id,category_id:category.id,status_id:status.id,name:'Servicio QA',kind:'SERVICE',service_unit_label:'Servicio',quantity_decimals:2,price:100,cost:0}})
    const completed=await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
    const sale=await db.$transaction(async tx=>{
      const sale=await tx.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:completed.id,payment_method_id:f.card.id,total:100,adjusted_total:100,items:1,payment_status:'PAID',created_by:f.user.id,cash_register_session_id:f.period.id,
      sale_items:{create:{product_id:product.id,price:100,net_total:100,qty:1,item_name:product.name,item_kind:'SERVICE',unit_label:'Servicio',quantity_decimals:2}}},include:{sale_items:true}})
      const session=await require('../src/services/cashSessionBoundary').lockScopedSession(tx,f.scope,f.period.id)
      await require('../src/modules/cash-closure/events').recordMoneyEvent(tx,f.scope,{session,sourceType:'SALE',sourceId:sale.id})
      return sale
    })
    const approved=await db.returnStatus.upsert({where:{name:'Aprobada'},create:{name:'Aprobada'},update:{}})
    await db.returnStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
    for(const amount of [40,60]) {
      const returned=await db.return.create({data:{reference:'QA-'+randomUUID().slice(0,12),sale_id:sale.id,status_id:approved.id,total_refund:amount,approved_resolution:'CUSTOMER_CREDIT',
        return_items:{create:{sale_item_id:sale.sale_items[0].id,product_id:product.id,qty_returned:String(amount/100),refund_amount:amount}}},include:{return_items:true}})
      await require('../src/modules/returns/application').completeReturn(db,{id:returned.id,scope:{branch_id:f.branch.id,branch:{company_id:f.company.id}},companyId:f.company.id,userId:f.user.id,permissions:['returns.complete'],
        payload:{idempotency_key:randomUUID(),lines:[{return_item_id:returned.return_items[0].id}]}})
    }
    const [origin]=await db.$queryRaw`SELECT id FROM cash_money_events WHERE source_type='SALE' AND source_id=${sale.id}::uuid`
    const context=await require('../src/modules/cash-closure/disputes.queries').originContext(db,f.scope,origin.id)
    assert.equal(context.eligible,true)
    const doc=await db.$transaction(tx=>require('../src/modules/cash-closure/disputes').createDispute(tx,f.scope,{eventId:origin.id,claimed:'50',providerReference:randomUUID(),reason:'Reclamo posterior a devolución',requestKey:randomUUID()}))
    const [hold]=await db.$queryRaw`SELECT sum(held)::text AS held FROM customer_receipt_restrictions WHERE dispute_id=${doc.id}::uuid`
    assert.equal(hold.held,'50.00')
    const rules=require('../src/modules/receivables/domain/paymentAllocations')
    const notes=await rules.hydrateReceiptAllocations(db,await db.customerPayment.findMany({where:{customer_id:f.customer.id,kind:'CREDIT_NOTE'},select:{id:true,amount:true,...rules.allocationSelect}}))
    assert.equal(notes.length,2)
    assert.equal(notes.reduce((sum,n)=>sum+Number(rules.allocationForReceipt(n).available),0),50)
    assert.equal(await db.cashRefundAllocation.count({where:{origin_event_id:origin.id,action:'TRANSFER'}}),2)
    assert.equal(await db.cashMoneyEvent.count({where:{source_type:'RETURN_SETTLEMENT'}}),0)
    const usable=notes.find(n=>Number(rules.allocationForReceipt(n).available)>=40)
    const credit=await db.paymentMethod.create({data:{company_id:f.company.id,name:'Crédito de saldo QA',is_credit:true}})
    const target=await db.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:completed.id,payment_method_id:credit.id,total:40,adjusted_total:40,items:0,created_by:f.user.id}})
    await db.salePaymentEntry.create({data:{sale_id:target.id,customer_payment_id:usable.id,amount:'40'}})
    const returned=await db.return.create({data:{sale_id:target.id,status_id:approved.id,total_refund:40}})
    await db.$transaction(async tx=>{
      const refunds=require('../src/modules/cash-closure/disputes.refunds')
      await refunds.prepareSaleRefundMutation(tx,f.scope,target.id)
      await tx.sale.update({where:{id:target.id},data:{adjusted_total:0,total_returned:40}})
      const result=await require('../src/modules/receivables').releaseSaleOverpaymentWithPlan(tx,target.id,40)
      const settlement=await tx.returnSettlement.create({data:{return_id:returned.id,kind:'REFUND',amount:'40',registered_by:f.user.id,idempotency_key:randomUUID()}})
      await refunds.recordReturnAllocations(tx,f.scope,settlement.id,result.allocations)
    })
    assert.equal((await require('../src/modules/cash-closure/disputes.queries').originContext(db,f.scope,origin.id)).claimable,'10.00')
    const after=await rules.hydrateReceiptAllocations(db,await db.customerPayment.findMany({where:{id:{in:notes.map(n=>n.id)}},select:{id:true,amount:true,...rules.allocationSelect}}))
    assert.equal(after.reduce((sum,n)=>sum+Number(rules.allocationForReceipt(n).available),0),10)
    const [current]=await db.$queryRaw`SELECT version FROM cash_payment_disputes WHERE id=${doc.id}::uuid`
    async function approve(kind,payload,version) {
      const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
        VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${kind},${JSON.stringify(payload)}::jsonb,${'b'.repeat(64)},${version},${f.user.id}::uuid) RETURNING id`
      await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`
      return p.id
    }
    await db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',50,'2026-11-23','QA-RETIRO',${f.user.id}::uuid)`
    await approve('RESULT',{won:'0.00',lost:'50.00'},current.version)
    await db.$executeRaw`UPDATE cash_payment_disputes SET status='LOST',lost=50,version=version+1 WHERE id=${doc.id}::uuid`
    const disposition=await approve('DISPOSITION',{customerPrincipal:'50.00',absorbedPrincipal:'0.00'},current.version+1)
    await assert.rejects(db.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,kind,principal) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${disposition}::uuid,'RECEIPT_RETIRED',1)`,/dispute_retired_receipt/)
    await assert.rejects(db.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,payment_id,kind,principal) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${disposition}::uuid,${notes[0].id}::uuid,'RECEIPT_RETIRED',1)`,/dispute_receipt_reservation_stale/)
    const retired=await db.$transaction(async tx=>{
      const result=[]
      for(const note of notes) {
        const amount=String(note.amount)==='40'?'40':'10'
        const [lot]=await tx.$queryRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,payment_id,kind,principal) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${disposition}::uuid,${note.id}::uuid,'RECEIPT_RETIRED',${amount}::numeric) RETURNING id,payment_id,principal`
        result.push(lot)
      }
      await require('../src/modules/cash-closure/disputes.receipts').refreshOriginReceiptRestrictions(tx,f.scope,origin.id)
      return result
    })
    const [projection]=await db.$queryRaw`SELECT sum(held)::text AS held,sum(retired)::text AS retired FROM customer_receipt_restrictions WHERE dispute_id=${doc.id}::uuid`
    assert.deepEqual(projection,{held:'0.00',retired:'50.00'})
    await db.$transaction(async tx=>{
      const [recovery]=await tx.$queryRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_RECOVERY',30,'2026-11-23','QA-RECUPERACION',${f.user.id}::uuid) RETURNING id`
      for(const lot of retired)await tx.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,event_id,payment_id,target_lot_id,kind,principal) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${recovery.id}::uuid,${lot.payment_id}::uuid,${lot.id}::uuid,'RECOVERED',${String(lot.principal)==='40'?'24':'6'}::numeric)`
      await require('../src/modules/cash-closure/disputes.receipts').refreshOriginReceiptRestrictions(tx,f.scope,origin.id)
    })
    const recovered=await rules.hydrateReceiptAllocations(db,await db.customerPayment.findMany({where:{id:{in:notes.map(n=>n.id)}},select:{id:true,amount:true,...rules.allocationSelect}}))
    assert.equal(recovered.reduce((sum,n)=>sum+Number(rules.allocationForReceipt(n).available),0),40)
    assert.equal(await db.customerRecoveryCredit.count(),0)
  } finally {await db.$disconnect()}
})
