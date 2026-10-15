const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
const {resolveEngagementFunds}=require('../src/modules/appointments/engagementResolution')
test('issuing, releasing and requesting a refund compete for one version and preserve the receipt budget',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  await db.companyModule.create({data:{company_id:scope.companyId,module_code:'accounting',status:'DISABLED'}})
  await db.commercialDocumentLine.deleteMany({where:{document_id:f.quoteId,item_kind:'STANDARD'}})
  await db.commercialDocument.update({where:{id:f.quoteId},data:{total:150,subtotal:150}})
  const e=await f.paidEngagement('40.00'),receipt=await db.customerPayment.findFirst({where:{commitments:{some:{engagement_id:e.id}}}})
  const p={amount:'10.00',receiptId:receipt.id,reason:'Decisión explícita',expectedVersion:e.version,idempotencyKey:crypto.randomUUID()}
  const results=await Promise.allSettled([
    resolveEngagementFunds(db,scope,e.id,{...p,action:'RELEASE'}),
    resolveEngagementFunds(db,scope,e.id,{...p,action:'REQUEST_REFUND',idempotencyKey:crypto.randomUUID()}),
    require('../src/modules/appointments/engagementSales').issueEngagementSale(db,scope,e.id,{...f.saleTerms,expectedVersion:e.version,idempotencyKey:crypto.randomUUID()})
  ])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'STALE_VERSION')
  const {allocationSelect,allocationForReceipt}=require('../src/modules/receivables')
  const budget=allocationForReceipt(await db.customerPayment.findUnique({where:{id:receipt.id},select:{amount:true,...allocationSelect}}))
  assert.equal(Number(budget.applied)+Number(budget.committed)+Number(budget.refunded)+Number(budget.available),40)
  assert.equal(await db.customerPayment.count(),1)
}))
