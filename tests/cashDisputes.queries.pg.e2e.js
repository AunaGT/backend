const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture,insertCase}=require('./helpers/cashDisputesQa.cjs')
const q=require('../src/modules/cash-closure/disputes.queries')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
test('origin eligibility, coverage and parent scope are derived from original bank receipts',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),ctx=await q.originContext(db,f.scope,f.event.id)
    assert.equal(ctx.eligible,true);assert.equal(ctx.amount,'100.00');assert.equal(ctx.claimable,'100.00');assert.equal(ctx.customerId,f.customer.id)
    const id=await insertCase(db,f,{claimed:'60.00'})
    assert.equal((await q.originContext(db,f.scope,f.event.id)).claimable,'40.00')
    const doc=await q.getDispute(db,f.scope,id)
    assert.equal(doc.claimed,'60.00');assert.equal(doc.withdrawn,'0.00');assert.equal(doc.charged,'0.00')
    const all={...f.scope,branchId:null,branchIds:[f.branch.id]}
    assert.equal((await q.listDisputes(db,all,{})).totalItems,1)
    assert.equal((await q.listDisputes(db,f.scope,{status:'LOST'})).totalItems,0)
    const foreign=await fixture(db)
    await assert.rejects(q.originContext(db,foreign.scope,f.event.id),{status:404})
    await assert.rejects(q.getDispute(db,foreign.scope,id),{status:404})
    await assert.rejects(q.getDispute(db,{...f.scope,can:{read:false}},id),{status:403})
    await assert.rejects(q.getDispute(db,f.scope,randomUUID()),{status:404})
  }finally{await db.$disconnect()}
})
test('missing dispute schema advertises unavailability and does not block original cash features',{skip:!url,timeout:240000},async()=>{
  const qa=await qaSchema(url,{migrate:false})
  try{assert.equal(await q.disputesAvailable(qa.db),false);qa.apply();assert.equal(await q.disputesAvailable(qa.db),true)}finally{await qa.db.$disconnect()}
})
