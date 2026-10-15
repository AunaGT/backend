const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
const {createEngagement}=require('../src/modules/appointments/engagements')
const {issueEngagementSale}=require('../src/modules/appointments/engagementSales')
test('two issue keys and a simultaneous ordinary credit application create one principal sale and no reused advance',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  const e=await createEngagement(db,scope,{contactId:f.contactId,lines:[{productId:f.productId,quantity:'1'}],idempotencyKey:crypto.randomUUID()})
  const results=await Promise.allSettled([
    ...[1,2].map(()=>issueEngagementSale(db,scope,e.id,{...f.saleTerms,expectedVersion:e.version,idempotencyKey:crypto.randomUUID()})),
    db.$transaction(tx=>require('../src/modules/receivables').applyAvailableCredit(tx,f.contactId,scope.branchId))
  ])
  assert.ok(results.slice(0,2).some(r=>r.status==='fulfilled'))
  for(const result of results.slice(0,2))if(result.status==='rejected')assert.equal(result.reason.code,'STALE_VERSION')
  assert.equal(await db.sale.count({where:{settlement_source:'ENGAGEMENT_RECEIPTS'}}),1)
  assert.equal(await db.customerPayment.count(),0)
}))
test('an external invoice holding the order lock cannot race Agenda into a second sale for a delivered mixed order',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  const order=await require('./helpers/commercialAgendaFixture.cjs').createDeliveredOrder(db,scope,f)
  const e=await f.paidEngagement('40.00')
  let held,release;const locked=new Promise(resolve=>{held=resolve}),gate=new Promise(resolve=>{release=resolve})
  const external=db.$transaction(async tx=>{
    const operations=require('../src/modules/orders/fulfillment')
    const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId},params:{id:order.id},body:{request_key:crypto.randomUUID(),payment_method_id:f.creditMethod.id,lines:order.lines.map(l=>({line_id:l.id,qty:l.qty.toString()}))}}
    await operations.lockedOrder(tx,req);held();await gate
    return operations.invoice(tx,req,()=>{throw Error('No fictitious receipt')})
  })
  await locked
  const agenda=issueEngagementSale(db,scope,e.id,{...f.saleTerms,expectedVersion:e.version,idempotencyKey:crypto.randomUUID()})
  release()
  const result=await Promise.allSettled([external,agenda])
  assert.equal(result[0].status,'rejected');assert.equal(result[0].reason.code,'ENGAGEMENT_OWNS_SOURCE')
  assert.equal(result[1].status,'fulfilled')
  assert.equal(await db.commercialDocumentSale.count({where:{document_id:order.id}}),1)
  assert.equal(await db.stockMovement.count(),0)
}))
