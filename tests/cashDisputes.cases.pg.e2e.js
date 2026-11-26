const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const flow=require('../src/modules/cash-closure/disputes')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
const input=f=>({eventId:f.event.id,claimed:'100.00',providerReference:'CB-'+randomUUID(),reason:'El banco informó un reclamo',evidence:{identifier:'Consulta bancaria QA'},requestKey:randomUUID()})
test('creating a case reserves only unallocated receipt funds and replay creates no debt or money',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),b=input(f)
    const before=await db.$queryRaw`SELECT id,content_hash FROM cash_money_events ORDER BY id`
    const run=()=>db.$transaction(tx=>flow.createDispute(tx,f.scope,b),{timeout:30000})
    const a=await run(),again=await run()
    assert.deepEqual(again,a)
    assert.equal(a.status,'OPEN');assert.equal(a.charged,'0.00');assert.equal(a.withdrawn,'0.00')
    const [hold]=await db.$queryRaw`SELECT held::text,retired::text FROM customer_receipt_restrictions WHERE dispute_id=${a.id}::uuid`
    assert.deepEqual(hold,{held:'100.00',retired:'0.00'})
    assert.equal(await require('../src/modules/receivables').availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
    assert.deepEqual(await db.$queryRaw`SELECT id,content_hash FROM cash_money_events ORDER BY id`,before)
    const [{n}]=await db.$queryRaw`SELECT count(*)::int AS n FROM customer_dispute_charges`
    assert.equal(n,0)
    await assert.rejects(db.$transaction(tx=>flow.createDispute(tx,f.scope,{...b,claimed:'99.00'})),{status:409})
    await assert.rejects(db.$transaction(tx=>flow.createDispute(tx,{...f.scope,can:{read:true}},input(f))),{status:403})
  }finally{await db.$disconnect()}
})
test('concurrent cases cannot claim the same remaining principal and duplicate references do not double reserve',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),base=input(f)
    const results=await Promise.allSettled([0,1].map(()=>db.$transaction(tx=>flow.createDispute(tx,f.scope,{...base,claimed:'60.00',providerReference:randomUUID(),requestKey:randomUUID()}),{timeout:30000})))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(results.find(r=>r.status==='rejected').reason.status,409)
    const doc=results.find(r=>r.status==='fulfilled').value
    await assert.rejects(db.$transaction(tx=>flow.createDispute(tx,f.scope,{...base,claimed:'10.00',providerReference:doc.providerReference,requestKey:randomUUID()})),{status:409})
  }finally{await db.$disconnect()}
})
