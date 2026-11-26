const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture,insertCase}=require('./helpers/cashDisputesQa.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
const posting=require('../src/services/accounting/cashDisputePosting'),settlements=require('../src/modules/cash-closure/settlements')
const run=(db,fn)=>db.$transaction(fn,{timeout:20000})
async function prepared(db,{active=true}={}){
 const f=await fixture(db)
 await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:active?'ACTIVE':'DISABLED'}})
 const asset=await db.account.create({data:{company_id:f.company.id,code:'1190',name:'Fondos en disputa',type:'ASSET'}})
 const advance=await db.account.create({data:{company_id:f.company.id,code:'2190',name:'Anticipos',type:'LIABILITY'}})
 await db.$executeRaw`INSERT INTO cash_dispute_settings(company_id,dispute_account_id,fee_account_id,updated_by_id,reason) VALUES(${f.company.id}::uuid,${asset.id},${f.accounts.fee.id},${f.user.id}::uuid,'Configuración QA')`
 if(active)await run(db,tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'CUSTOMER_ADVANCE',source_id:f.paymentId,description:'Cobro original',lines:[{account_id:f.accounts.clearing.id,debit:'100.00'},{account_id:advance.id,credit:'100.00'}]}))
 return{...f,asset,advance}
}
// Simula una deducción creada antes de este bloque: sin expediente ni la verificación nueva.
async function legacySettlement(db,f,raw){
 const queries=require('../src/modules/cash-closure/disputes.queries'),original=queries.disputesAvailable
 queries.disputesAvailable=async()=>false
 await db.$executeRawUnsafe('ALTER TABLE cash_settlements DISABLE TRIGGER cash_dispute_settlement_links')
 try{return await run(db,tx=>settlements.createSettlement(tx,f.scope,raw))}
 finally{queries.disputesAvailable=original;await db.$executeRawUnsafe('ALTER TABLE cash_settlements ENABLE TRIGGER cash_dispute_settlement_links')}
}
async function example(db,{active=true,alreadyDispute=false}={}){
 const f=await prepared(db,{active}),{asset}=f
 const result=await legacySettlement(db,f,{paymentMethodId:f.card.id,requestKey:randomUUID(),net:'80.00',deposit:{reference:randomUUID(),depositedOn:'2026-11-23',totalAmount:'80.00'},allocations:[{eventId:f.event.id,amount:'100.00'}],deductions:[{kind:'CHARGEBACK',eventId:f.event.id,amount:'20.00',accountId:alreadyDispute?asset.id:f.accounts.fee.id,description:'Descuento histórico'}]})
 const [deduction]=await db.$queryRaw`SELECT * FROM cash_settlement_deductions WHERE settlement_id=${result.settlement.id}::uuid`
 const id=await insertCase(db,f)
 return{...f,id,deduction,settlement:result.settlement}
}
const command=(f,extra={})=>({deductionId:f.deduction.id,principal:'20.00',reference:'DEDUCCIÓN ORIGINAL',expectedVersion:1,requestKey:randomUUID(),...extra})
const link=(db,f,raw)=>run(db,tx=>require('../src/modules/cash-closure/disputes.settlements').linkLegacyDeduction(tx,f.scope,f.id,raw))
async function originals(db,f){
 return db.$queryRaw`SELECT 'settlement' AS kind,to_jsonb(s) AS row FROM cash_settlements s WHERE company_id=${f.company.id}::uuid
 UNION ALL SELECT 'deduction',to_jsonb(x) FROM cash_settlement_deductions x JOIN cash_settlements s ON s.id=x.settlement_id WHERE s.company_id=${f.company.id}::uuid
 UNION ALL SELECT 'money',to_jsonb(e) FROM cash_money_events e WHERE company_id=${f.company.id}::uuid
 UNION ALL SELECT 'payment',to_jsonb(p) FROM customer_payments p WHERE p.branch_id=${f.branch.id}::uuid ORDER BY kind,row`
}
test('verified historical deductions append a reclassification without another bank debit or changed history',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db),before=await originals(db,f),entries=await db.journalEntry.count(),raw=command(f)
  const queries=require('../src/modules/cash-closure/disputes.queries')
  assert.deepEqual((await queries.getDispute(db,f.scope,f.id)).legacyDeductions.map(d=>[d.id,d.amount,d.settlementId,d.depositedOn]),[[f.deduction.id,'20.00',f.settlement.id,'2026-11-23']],'the case offers its unlinked historical deduction')
  assert.deepEqual((await queries.listDisputes(db,f.scope,{methodId:String(f.card.id)})).items.map(i=>[i.id,i.payment_method_id]),[[f.id,f.card.id]])
  assert.equal((await queries.listDisputes(db,f.scope,{methodId:String(f.card.id+999)})).totalItems,0)
  const result=await link(db,f,raw)
  assert.deepEqual((await queries.getDispute(db,f.scope,f.id)).legacyDeductions,[],'a linked deduction is no longer offered')
  assert.equal(result.withdrawn,'20.00');assert.deepEqual(await link(db,f,raw),result)
  assert.deepEqual(await originals(db,f),before);assert.equal(await db.journalEntry.count(),entries+1)
  const event=await db.cashDisputeEvent.findFirst({where:{dispute_id:f.id,kind:'LEGACY_WITHHOLDING'}})
  assert.equal(event.accounting_status,'POSTED');assert.equal(event.deduction_id,f.deduction.id)
  const entry=await db.journalEntry.findUnique({where:{id:event.journal_entry_id},include:{lines:true}})
  const inspection=await posting.inspectDisputeAccounting(db,f.scope,f.id)
  assert.equal(inspection.sources[0].accountingRoute,'RECLASSIFICATION')
  assert.equal(inspection.sources[0].settlementId,f.settlement.id)
  assert.equal(inspection.sources[0].settlementReference,f.settlement.deposit_reference)
  assert.deepEqual(entry.lines.map(l=>({id:l.account_id,debit:l.debit.toFixed(2),credit:l.credit.toFixed(2)})).sort((a,b)=>a.id-b.id),[{id:f.accounts.fee.id,debit:'0.00',credit:'20.00'},{id:f.asset.id,debit:'20.00',credit:'0.00'}].sort((a,b)=>a.id-b.id))
  await assert.rejects(link(db,f,{...raw,requestKey:randomUUID(),expectedVersion:result.version}),{code:'DISPUTE_DEDUCTION_LINKED'})
  await assert.rejects(link(db,f,{...raw,principal:'19.99'}),{code:'DISPUTE_ATTEMPT_CONFLICT'})
 }finally{await db.$disconnect()}
})
test('a historical deduction already posted to the dispute asset reuses the settlement journal exactly once',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db,{alreadyDispute:true}),count=await db.journalEntry.count(),before=await originals(db,f)
  await assert.rejects(link(db,f,command(f,{accountingDate:'2026-11-24',dateChangeReason:'Fecha elegida distinta'})),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
  assert.equal(await db.cashDisputeEvent.count(),0)
  await link(db,f,command(f))
  const event=await db.cashDisputeEvent.findFirst({where:{dispute_id:f.id,kind:'LEGACY_WITHHOLDING'}})
  assert.equal(event.accounting_status,'INTEGRATED');assert.equal(event.journal_entry_id,f.settlement.journal_entry_id)
  assert.equal((await posting.inspectDisputeAccounting(db,f.scope,f.id)).sources[0].accountingRoute,'SETTLEMENT')
  assert.equal(await db.journalEntry.count(),count);assert.deepEqual(await originals(db,f),before)
  assert.deepEqual(await run(db,tx=>posting.postDisputeEffect(tx,f.scope,event.id)),{entryId:f.settlement.journal_entry_id,status:'INTEGRATED'})
 }finally{await db.$disconnect()}
})
test('raw partial or cross-origin historical links are rejected before they can masquerade as withdrawals',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db),other=await example(db)
  for(const [deduction,principal]of [[f.deduction,'19.99'],[other.deduction,'20.00']])await assert.rejects(db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,settlement_id,deduction_id,actor_id)
    VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'LEGACY_WITHHOLDING',${principal}::numeric,'2026-11-23',${deduction.settlement_id}::uuid,${deduction.id}::uuid,${f.user.id}::uuid)`,/dispute_legacy_deduction/)
  assert.equal(await db.cashDisputeEvent.count(),0)
 }finally{await db.$disconnect()}
})
test('linking is exact, scoped and versioned, and a closed accounting period rolls the whole command back',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db),other=await example(db),raw=command(f)
  await assert.rejects(link(db,f,{...raw,principal:'19.99'}),{code:'DISPUTE_DEDUCTION_AMOUNT'})
  await assert.rejects(link(db,f,{...raw,deductionId:other.deduction.id}),{status:404})
  await assert.rejects(link(db,f,{...raw,expectedVersion:99}),{code:'DISPUTE_VERSION_CONFLICT'})
  await assert.rejects(link(db,{...f,scope:{...f.scope,can:{...f.scope.can,movements:false}}},raw),{status:403})
  await db.accountingPeriod.updateMany({where:{company_id:f.company.id,year:2026,month:11},data:{status:'CLOSED'}})
  await assert.rejects(link(db,f,raw),/cerrad|closed/i)
  assert.equal(await db.cashDisputeEvent.count({where:{dispute_id:f.id}}),0)
  assert.equal(await db.cashDisputeCommand.count({where:{company_id:f.company.id}}),0)
  await link(db,f,{...raw,accountingDate:'2026-12-01',dateChangeReason:'Reclasificación en el siguiente período abierto'})
  const effect=await db.cashDisputeEvent.findFirst({where:{dispute_id:f.id}})
  assert.equal(effect.economic_on.toISOString().slice(0,10),'2026-11-23');assert.equal(effect.accounting_on.toISOString().slice(0,10),'2026-12-01')
 }finally{await db.$disconnect()}
})
test('deferred adoption stays unposted until both original and settlement entries can be verified',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db,{active:false});await link(db,f,command(f))
  const event=await db.cashDisputeEvent.findFirst({where:{dispute_id:f.id}})
  assert.equal(event.accounting_status,'DEFERRED');assert.equal(await db.journalEntry.count(),0)
  await db.companyModule.updateMany({where:{company_id:f.company.id,module_code:'accounting'},data:{status:'ACTIVE'}})
  await assert.rejects(run(db,tx=>posting.postDisputeEffect(tx,f.scope,event.id,{accountingDate:'2026-11-24',dateChangeReason:'Registro posterior'})),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
  assert.equal(await db.journalEntry.count(),0)
 }finally{await db.$disconnect()}
})
test('a linked settlement cannot be voided through the old service or raw writer',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db);await link(db,f,command(f));const before=await originals(db,f)
  await assert.rejects(run(db,tx=>settlements.voidSettlement(tx,f.scope,f.settlement.id,{reason:'Anulación antigua'})),{code:'CASH_SETTLEMENT_DISPUTE_DEPENDENCY'})
  await assert.rejects(db.$executeRaw`UPDATE cash_settlements SET status='VOIDED',void_reason='Intento directo',voided_by_id=${f.user.id}::uuid WHERE id=${f.settlement.id}::uuid`,/dispute_settlement_dependency/)
  assert.deepEqual(await originals(db,f),before)
 }finally{await db.$disconnect()}
})
test('a settlement journal with the wrong deduction counterpart cannot authorize a reclassification',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db,{active:false})
  await db.companyModule.updateMany({where:{company_id:f.company.id,module_code:'accounting'},data:{status:'ACTIVE'}})
  const core=require('../src/services/accounting/core')
  await run(db,tx=>core.createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'CUSTOMER_ADVANCE',source_id:f.paymentId,description:'Cobro original',lines:[{account_id:f.accounts.clearing.id,debit:'100.00'},{account_id:f.advance.id,credit:'100.00'}]}))
  const wrong=await run(db,tx=>core.createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'CASH_SETTLEMENT',source_id:f.settlement.id,description:'Asiento histórico incompatible',lines:[{account_id:f.accounts.bank.id,debit:'80.00'},{account_id:f.accounts.income.id,debit:'20.00'},{account_id:f.accounts.clearing.id,credit:'100.00'}]}))
  await db.$executeRaw`UPDATE cash_settlements SET journal_entry_id=${wrong.id}::uuid WHERE id=${f.settlement.id}::uuid`
  await assert.rejects(link(db,f,command(f)),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
  assert.equal(await db.cashDisputeEvent.count(),0);assert.equal(await db.cashDisputeCommand.count(),0)
 }finally{await db.$disconnect()}
})
test('deferred accounting inspection explains a frozen account that became inactive before posting',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await example(db)
  await db.companyModule.updateMany({where:{company_id:f.company.id,module_code:'accounting'},data:{status:'DISABLED'}})
  await link(db,f,command(f))
  await db.companyModule.updateMany({where:{company_id:f.company.id,module_code:'accounting'},data:{status:'ACTIVE'}})
  await db.account.update({where:{id:f.asset.id},data:{active:false}})
  const result=await posting.inspectDisputeAccounting(db,f.scope,f.id)
  assert.equal(result.status,'BLOCKED');assert.match(result.issues.join(' '),/inactiva/)
  assert.equal((await db.cashDisputeEvent.findFirst({where:{dispute_id:f.id}})).accounting_status,'DEFERRED')
 }finally{await db.$disconnect()}
})
test('adoption and settlement void serialize in both orders without orphan effects or deadlocks',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  for(const linkFirst of [true,false]){
   const f=await example(db),raw=command(f)
   let firstReady,release,secondReady
   const ready=new Promise(r=>firstReady=r),gate=new Promise(r=>release=r),started=new Promise(r=>secondReady=r)
   const action=(tx,adopt)=>adopt?require('../src/modules/cash-closure/disputes.settlements').linkLegacyDeduction(tx,f.scope,f.id,raw):settlements.voidSettlement(tx,f.scope,f.settlement.id,{reason:'Anulación concurrente QA'})
   const first=run(db,async tx=>{const result=await action(tx,linkFirst);firstReady();await gate;return result})
   await ready
   const second=run(db,async tx=>{const [{pid}]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;secondReady(pid);return action(tx,!linkFirst)})
   const secondResult=second.then(value=>({value}),error=>({error})),pid=await started
   try{
    let blocked=false
    for(let n=0;n<200;n++){
     const [state]=await db.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`
     if(state?.wait_event_type==='Lock'){blocked=true;break}
     await new Promise(r=>setTimeout(r,20))
    }
    assert.equal(blocked,true,'La segunda transacción debe estar esperando el lock real de la primera')
   }finally{release()}
   await first
   const outcome=await secondResult
   assert.equal(outcome.error?.status,409)
   assert.notEqual(outcome.error?.code,'40P01')
   assert.equal(await db.cashDisputeEvent.count({where:{dispute_id:f.id,kind:'LEGACY_WITHHOLDING'}}),linkFirst?1:0)
   const [state]=await db.$queryRaw`SELECT status FROM cash_settlements WHERE id=${f.settlement.id}::uuid`
   assert.equal(state.status,linkFirst?'POSTED':'VOIDED')
  }
 }finally{await db.$disconnect()}
})

const settle=(db,scope,raw)=>run(db,tx=>settlements.createSettlement(tx,scope,raw))
const deposit=(net,day='2026-11-23')=>({reference:randomUUID(),depositedOn:day,totalAmount:net})
async function otherPayment(db,f,amount){
 const payment=await run(db,tx=>require('../src/modules/receivables').applyPayment(tx,{...f.scope,customerId:f.customer.id,amount,paymentMethodId:f.card.id,cashRegisterSessionId:f.period.id,allowAdvance:true}))
 return (await db.$queryRaw`SELECT * FROM cash_money_events WHERE source_id=${payment.paymentId}::uuid`)[0]
}
test('a new settlement chargeback needs its case and becomes one integrated withdrawal on the settlement journal',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await prepared(db),id=await insertCase(db,f),scope={...f.scope,isAdmin:false,canDisputeMovements:true}
  const raw={paymentMethodId:f.card.id,requestKey:randomUUID(),net:'80.00',deposit:deposit('80.00'),allocations:[{eventId:f.event.id,amount:'100.00'}],
   deductions:[{kind:'CHARGEBACK',eventId:f.event.id,disputeId:id,amount:'20.00',description:'Contracargo del proveedor'}]}
  const {disputeId,...orphan}=raw.deductions[0]
  await assert.rejects(settle(db,scope,{...raw,deductions:[orphan]}),{code:'CASH_SETTLEMENT_DISPUTE_REQUIRED'})
  await assert.rejects(settle(db,{...scope,canDisputeMovements:false},raw),{code:'DISPUTE_FORBIDDEN'})
  await assert.rejects(settle(db,scope,{...raw,deductions:[{...raw.deductions[0],accountId:f.accounts.fee.id}]}),{code:'CASH_SETTLEMENT_ACCOUNT'})
  const entries=await db.journalEntry.count(),first=await settle(db,scope,raw)
  assert.equal((await settle(db,scope,raw)).settlement.id,first.settlement.id,'a replay returns the same settlement')
  assert.equal(await db.journalEntry.count(),entries+1,'one settlement entry, no separate dispute entry')
  const [event]=await db.$queryRaw`SELECT * FROM cash_dispute_events WHERE dispute_id=${id}::uuid AND principal>0`
  assert.equal(event.kind,'PROVIDER_WITHHOLDING');assert.equal(event.settlement_id,first.settlement.id);assert.equal(event.deduction_id,first.settlement.deductions[0].id)
  assert.equal(event.accounting_status,'INTEGRATED');assert.equal(event.journal_entry_id,first.settlement.journal_entry_id)
  assert.equal(first.settlement.deductions[0].dispute_id,id)
  const entry=await db.journalEntry.findUnique({where:{id:event.journal_entry_id},include:{lines:true}})
  const byAccount=Object.fromEntries(entry.lines.map(l=>[l.account_id,l.debit.sub(l.credit).toFixed(2)]))
  assert.deepEqual(byAccount,{[f.accounts.bank.id]:'80.00',[f.asset.id]:'20.00',[f.accounts.clearing.id]:'-100.00'})
  const dispute=await require('../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,id)
  assert.equal(dispute.withdrawn,'20.00');assert.ok(dispute.version>1,'the case version moves with its new effect')
  await assert.rejects(run(db,tx=>settlements.voidSettlement(tx,f.scope,first.settlement.id,{reason:'Anulación'})),{code:'CASH_SETTLEMENT_DISPUTE_DEPENDENCY'})
 }finally{await db.$disconnect()}
})
test('a provider recovery added to a later deposit raises the net, credits the dispute funds and cannot exceed what was withdrawn',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await prepared(db),id=await insertCase(db,f),scope={...f.scope,canDisputeMovements:true}
  await settle(db,scope,{paymentMethodId:f.card.id,requestKey:randomUUID(),net:'80.00',deposit:deposit('80.00'),allocations:[{eventId:f.event.id,amount:'100.00'}],
   deductions:[{kind:'CHARGEBACK',eventId:f.event.id,disputeId:id,amount:'20.00',description:'Contracargo'}]})
  const later=await otherPayment(db,f,50)
  await run(db,tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-24',source_type:'CUSTOMER_ADVANCE',source_id:later.source_id,description:'Otro cobro',lines:[{account_id:f.accounts.clearing.id,debit:'50.00'},{account_id:f.advance.id,credit:'50.00'}]}))
  const base={paymentMethodId:f.card.id,allocations:[{eventId:later.id,amount:'50.00'}]}
  await assert.rejects(settle(db,scope,{...base,requestKey:randomUUID(),net:'70.01',deposit:deposit('70.01','2026-11-24'),recoveries:[{disputeId:id,amount:'20.01'}]}),{code:'DISPUTE_EFFECT_EXCEEDS'})
  await assert.rejects(settle(db,scope,{...base,requestKey:randomUUID(),net:'50.00',deposit:deposit('50.00','2026-11-24'),recoveries:[{disputeId:id,amount:'20.00'}]}),{code:'CASH_SETTLEMENT_BALANCE'})
  const result=await settle(db,scope,{...base,requestKey:randomUUID(),net:'70.00',deposit:deposit('70.00','2026-11-24'),recoveries:[{disputeId:id,amount:'20.00'}]})
  assert.equal(result.settlement.recoveries_total,'20.00');assert.deepEqual(result.settlement.recoveries.map(r=>[r.dispute_id,r.amount]),[[id,'20.00']])
  const entry=await db.journalEntry.findUnique({where:{id:result.settlement.journal_entry_id},include:{lines:true}})
  const byAccount=Object.fromEntries(entry.lines.map(l=>[l.account_id,l.debit.sub(l.credit).toFixed(2)]))
  assert.deepEqual(byAccount,{[f.accounts.bank.id]:'70.00',[f.asset.id]:'-20.00',[f.accounts.clearing.id]:'-50.00'})
  const dispute=await require('../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,id)
  assert.equal(dispute.withdrawn,'20.00');assert.equal(dispute.recovered,'20.00')
  await assert.rejects(db.$executeRaw`INSERT INTO cash_settlements(company_id,branch_id,deposit_id,currency_code,gross,refunds,deductions,recoveries,net,created_by_id,request_key,request_hash)
    SELECT company_id,branch_id,deposit_id,currency_code,0,0,0,5,5,created_by_id,gen_random_uuid(),'raw' FROM cash_settlements WHERE id=${result.settlement.id}::uuid`,/dispute_settlement_links|cash_settlement_deposit_total/)
 }finally{await db.$disconnect()}
})
test('while dispute commands are closed a chargeback without case is a historical deduction the case can link later',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url),release=require('../src/modules/cash-closure/disputes.release'),open=release.commandsReleased
 try{
  const f=await prepared(db),id=await insertCase(db,f),scope={...f.scope,isAdmin:false,canDisputeMovements:true}
  const raw={paymentMethodId:f.card.id,requestKey:randomUUID(),net:'80.00',deposit:deposit('80.00'),allocations:[{eventId:f.event.id,amount:'100.00'}],
   deductions:[{kind:'CHARGEBACK',eventId:f.event.id,amount:'20.00',accountId:f.accounts.fee.id,description:'Contracargo del proveedor'}]}
  release.commandsReleased=()=>false
  await assert.rejects(settle(db,scope,{...raw,requestKey:randomUUID(),deductions:[{...raw.deductions[0],disputeId:id,accountId:undefined}]}),{code:'CASH_SETTLEMENT_UNAVAILABLE'},'no dispute path runs while closed')
  const legacy=await settle(db,scope,raw)
  assert.equal(await db.cashDisputeEvent.count({where:{settlement_id:legacy.settlement.id}}),0)
  release.commandsReleased=open
  const dispute=await require('../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,id)
  assert.deepEqual(dispute.legacyDeductions.map(d=>d.amount),['20.00'],'the case finds the untracked chargeback')
  const linked=await run(db,tx=>require('../src/modules/cash-closure/disputes.settlements').linkLegacyDeduction(tx,f.scope,id,{deductionId:dispute.legacyDeductions[0].id,principal:'20.00',reference:'CONTRACARGO',expectedVersion:dispute.version,requestKey:randomUUID()}))
  assert.equal(linked.withdrawn,'20.00')
 }finally{release.commandsReleased=open;await db.$disconnect()}
})
