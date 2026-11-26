const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDailyQa.cjs')
const url=process.env.AUNA_CASH_DAILY_QA_URL
test('historical snapshots exclude live notices and settlements while current data remains separately queryable',{skip:!url,timeout:120000},async()=>{
  const qa=await qaSchema(url),{db}=qa
  try{
    const f=await fixture(db),api=require('../src/modules/cash-closure/dailyConsolidation'),s={...f.scope,canView:true,canFinalize:true},date='2026-01-03'
    const first=await api.dayView(db,s,date)
    assert.equal(first.snapshot.version,2);assert.equal(first.snapshot.digital.pendingNotices,undefined)
    const originalKey=first.contentKey
    await db.$transaction(tx=>require('../src/modules/cash-closure/notices').createNotice(tx,{...s,canCreate:true},{requestKey:randomUUID(),customerId:f.customer.id,amount:'20.00',paymentMethodId:f.bank.id,reportedPaidOn:'2026-11-19'}))
    const updated=await api.dayView(db,s,date)
    assert.equal(updated.contentKey,originalKey);assert.equal(updated.current.pendingNotices.count,1);assert.equal(updated.current.pendingNotices.amount,'20.00');assert.ok(updated.current.asOf)
    assert.equal(updated.snapshot.digital.toSettle,'0.00')
    const {view:final}=await db.$transaction(tx=>api.finalizeDay(tx,s,date,{contentKey:originalKey}))
    const stored=await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d WHERE branch_id=${f.branch.id}::uuid`
    assert.equal(stored[0].row.snapshot.current,undefined)
    await db.$transaction(tx=>require('../src/modules/cash-closure/notices').createNotice(tx,{...s,canCreate:true},{requestKey:randomUUID(),customerId:f.customer.id,amount:'5.00',paymentMethodId:f.bank.id,reportedPaidOn:'2026-11-19'}))
    const after=await api.dayView(db,s,date)
    assert.equal(after.current.pendingNotices.count,2);assert.deepEqual(after.snapshot,final.snapshot);assert.equal(after.contentKey,originalKey)
    assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d WHERE branch_id=${f.branch.id}::uuid`,stored)
  }finally{await db.$disconnect()}
})
test('a later real-date settlement keeps its original receipt and the finished operational snapshot unchanged',{skip:!url,timeout:120000},async()=>{
  const qa=await qaSchema(url),{db}=qa
  try{
    const f=await fixture(db),api=require('../src/modules/cash-closure/dailyConsolidation'),methods=require('../src/modules/cash-closure/bankMethods'),run=fn=>db.$transaction(fn,{timeout:30000})
    await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'ACTIVE'}})
    const {DEFAULT_ACCOUNT_KEYS}=require('../src/services/accounting/core'),map={bank:'1102'}
    for(const [i,key]of DEFAULT_ACCOUNT_KEYS.entries())if(key!=='bank'){map[key]=String(9000+i);await db.account.create({data:{company_id:f.company.id,code:map[key],name:key,type:'ASSET'}})}
    await db.systemSetting.create({data:{company_id:f.company.id,key:'accounting.defaultAccounts',value:JSON.stringify(map)}})
    const {version}=await run(tx=>methods.proposeBankMethod(tx,{...f.scope,canManage:true},{paymentMethodId:f.card.id,mode:'DEFERRED',destinationLabel:'Visanet',bankAccountId:f.accounts.bank.id,clearingAccountId:f.accounts.clearing.id,feeAccountId:f.accounts.fee.id}))
    await run(tx=>methods.approveBankMethod(tx,{...f.scope,isAdmin:true},version.id))
    const paid=await run(tx=>require('../src/modules/receivables').applyPayment(tx,{...f.scope,customerId:f.customer.id,amount:75,paymentMethodId:f.card.id,cashRegisterSessionId:f.period.id,allowAdvance:true}))
    await require('../src/services/accounting/postingEngine').postPendingOperations(db,f.user.id,f.company.id)
    await require('./helpers/cashDailyScenario.cjs').countAndFinalize(db,f,f.period.id)
    const [{day}]=await db.$queryRaw`SELECT business_date::text AS day FROM cash_register_sessions WHERE id=${f.period.id}::uuid`
    const scope={...f.scope,canView:true,canFinalize:true},provisional=await api.dayView(db,scope,day)
    const {view:final}=await run(tx=>api.finalizeDay(tx,scope,day,{contentKey:provisional.contentKey}))
    assert.equal(final.snapshot.digital.toSettle,'75.00')
    const stored=await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d WHERE branch_id=${f.branch.id}::uuid`
    const sourceProjection=()=>db.$queryRaw`SELECT 'sale' AS kind,to_jsonb(s) AS row FROM sales s WHERE branch_id=${f.branch.id}::uuid UNION ALL SELECT 'entry',to_jsonb(j) FROM journal_entries j WHERE company_id=${f.company.id}::uuid AND source_id=${paid.paymentId}::text ORDER BY kind,row`
    const before=await sourceProjection(),[event]=await db.$queryRaw`SELECT id FROM cash_money_events WHERE source_id=${paid.paymentId}::uuid`
    const nextDate=new Date(day+'T12:00:00Z');nextDate.setUTCDate(nextDate.getUTCDate()+1)
    await run(tx=>require('../src/modules/cash-closure/settlements').createSettlement(tx,{...f.scope,canSettle:true},{requestKey:randomUUID(),paymentMethodId:f.card.id,deposit:{reference:'VN-801',depositedOn:nextDate.toISOString().slice(0,10),totalAmount:'75.00'},net:'75.00',allocations:[{eventId:event.id,amount:'75.00'}],deductions:[]}))
    const after=await api.dayView(db,scope,day)
    assert.deepEqual(after.snapshot,final.snapshot);assert.equal(after.contentKey,final.contentKey);assert.equal(after.current.toSettle,'0.00');assert.equal(after.current.settlementReferences[0].reference,'VN-801')
    assert.deepEqual(await sourceProjection(),before);assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d WHERE branch_id=${f.branch.id}::uuid`,stored)
    const [allocation]=await db.$queryRaw`SELECT event_id FROM cash_settlement_allocations WHERE event_id=${event.id}::uuid`;assert.equal(allocation.event_id,event.id)
  }finally{await db.$disconnect()}
})
