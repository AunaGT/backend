const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const flow=require('../src/modules/cash-closure/disputes')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
async function create(db,f){return db.$transaction(tx=>flow.createDispute(tx,f.scope,{eventId:f.event.id,claimed:'100',providerReference:randomUUID(),reason:'Reclamo del banco',requestKey:randomUUID()}))}
test('reviewing a won result releases an unwithdrawn advance only after independent approval',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),doc=await create(db,f)
    const raw={kind:'RESULT',payload:{won:'100.00',lost:'0.00',reason:'El proveedor aceptó el soporte'},expectedVersion:doc.version}
    const preview=await flow.previewDisputeAction(db,f.scope,doc.id,raw)
    const proposal=await db.$transaction(tx=>flow.proposeDisputeAction(tx,f.scope,doc.id,{...raw,previewKey:preview.previewKey,requestKey:randomUUID()}))
    const decision={decision:'APPROVE',expectedVersion:doc.version,requestKey:randomUUID()}
    await assert.rejects(db.$transaction(tx=>flow.decideDisputeProposal(tx,{...f.scope,can:{...f.scope.can,resolve:true}},doc.id,proposal.id,decision)),{code:'DISPUTE_INDEPENDENT_REVIEW_REQUIRED'})
    const resolved=await db.$transaction(tx=>flow.decideDisputeProposal(tx,f.reviewer,doc.id,proposal.id,decision))
    assert.equal(resolved.status,'WON');assert.equal(resolved.withdrawn,'0.00');assert.equal(resolved.charged,'0.00')
    assert.equal(await require('../src/modules/receivables').availableCredit(db,f.customer.id,{branch_id:f.branch.id}),100)
    assert.deepEqual(await db.$transaction(tx=>flow.decideDisputeProposal(tx,f.reviewer,doc.id,proposal.id,decision)),resolved)
  }finally{await db.$disconnect()}
})
test('losing before the bank debit creates no debt but protects the affected unused advance',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),doc=await create(db,f)
    const raw={kind:'RESULT',payload:{won:'0',lost:'100',reason:'Decisión pendiente de retiro bancario'},expectedVersion:doc.version}
    const p=await flow.previewDisputeAction(db,f.scope,doc.id,raw)
    const proposal=await db.$transaction(tx=>flow.proposeDisputeAction(tx,f.scope,doc.id,{...raw,previewKey:p.previewKey,requestKey:randomUUID()}))
    const resolved=await db.$transaction(tx=>flow.decideDisputeProposal(tx,f.reviewer,doc.id,proposal.id,{decision:'APPROVE',expectedVersion:doc.version,requestKey:randomUUID()}))
    assert.equal(resolved.status,'LOST');assert.equal(resolved.charged,'0.00');assert.equal(resolved.withdrawn,'0.00')
    assert.equal(await require('../src/modules/receivables').availableCredit(db,f.customer.id,{branch_id:f.branch.id}),0)
  }finally{await db.$disconnect()}
})
test('replacing a cancelled incorrect case requires an explicit link and preserves its original history',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),doc=await create(db,f)
    const raw={kind:'CANCEL',payload:{reason:'El proveedor identificó otro origen'},expectedVersion:doc.version}
    const preview=await flow.previewDisputeAction(db,f.scope,doc.id,raw)
    const proposal=await db.$transaction(tx=>flow.proposeDisputeAction(tx,f.scope,doc.id,{...raw,previewKey:preview.previewKey,requestKey:randomUUID()}))
    const cancelled=await db.$transaction(tx=>flow.decideDisputeProposal(tx,f.reviewer,doc.id,proposal.id,{decision:'APPROVE',expectedVersion:doc.version,requestKey:randomUUID()}))
    assert.equal(cancelled.status,'CANCELLED')
    const body={eventId:f.event.id,claimed:'100',providerReference:doc.providerReference,reason:'Expediente corregido',requestKey:randomUUID()}
    await assert.rejects(db.$transaction(tx=>flow.createDispute(tx,f.scope,body)),{code:'DISPUTE_REPLACEMENT_REQUIRED'})
    await assert.rejects(db.$transaction(tx=>flow.createDispute(tx,f.scope,{...body,providerReference:'OTRA-REFERENCIA',replacesCaseId:doc.id,requestKey:randomUUID()})),{code:'DISPUTE_REPLACEMENT_INVALID'})
    const replacement=await db.$transaction(tx=>flow.createDispute(tx,f.scope,{...body,replacesCaseId:doc.id}))
    assert.equal(replacement.replacesCaseId,doc.id)
    assert.equal(replacement.status,'OPEN')
    const previous=await require('../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,doc.id)
    assert.equal(previous.status,'CANCELLED');assert.equal(previous.replacedByCaseId,replacement.id)
    assert.deepEqual(previous.history,cancelled.history)
  } finally {await db.$disconnect()}
})
test('a fee-only withdrawal must be resolved before the case can be cancelled',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try {
    const f=await fixture(db),doc=await create(db,f)
    await db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,fee,economic_on,reference,actor_id) VALUES(${doc.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',0,5,'2026-11-23','QA-COMISION',${f.user.id}::uuid)`
    await assert.rejects(flow.previewDisputeAction(db,f.scope,doc.id,{kind:'CANCEL',payload:{reason:'Corrección de origen'},expectedVersion:doc.version}),{code:'DISPUTE_STATE_CONFLICT'})
  } finally {await db.$disconnect()}
})
