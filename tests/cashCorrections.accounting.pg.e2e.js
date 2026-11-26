const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashCorrectionsQa.cjs'),flow=require('../src/modules/cash-closure/corrections')
const url=process.env.AUNA_CASH_DAILY_QA_URL
async function accounts(db,f){
  const cash=await db.account.create({data:{company_id:f.company.id,code:'1110',name:'Caja',type:'ASSET'}}),difference=await db.account.create({data:{company_id:f.company.id,code:'6100',name:'Diferencias',type:'EXPENSE'}})
  await db.systemSetting.create({data:{company_id:f.company.id,key:'accounting.defaultAccounts',value:JSON.stringify({cash:cash.code,cashOverShort:difference.code})}})
  return {cash,difference}
}
async function approve(db,f,actual,date='2026-11-20'){
  const ctx=await flow.correctionContext(db,f.scope,f.id),b={reason:'Conteo revisado',accountingDate:date,previousCorrectionId:ctx.previousCorrectionId,lines:ctx.lines.map(l=>({closurePaymentId:l.closurePaymentId,correctedActual:actual})),requestKey:randomUUID()}
  b.previewKey=(await flow.previewCorrection(db,f.scope,f.id,b)).previewKey
  const doc=await db.$transaction(tx=>flow.proposeCorrection(tx,f.scope,f.id,b))
  return db.$transaction(tx=>flow.decideCorrection(tx,f.reviewer,f.id,doc.id,{action:'APPROVE',requestKey:randomUUID(),expectedUpdatedAt:doc.updatedAt}))
}
test('cash chain posts original and exact sequential deltas once, preserving accounts and source uniqueness',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),acc=await accounts(db,f),a=await approve(db,f,'980'),b=await approve(db,f,'970')
    const posting=require('../src/services/accounting/cashClosurePosting')
    await Promise.all([1,2].map(()=>db.$transaction(tx=>posting.postClosureChain(tx,f.scope,f.id))))
    const entries=await db.journalEntry.findMany({where:{company_id:f.company.id},include:{lines:true},orderBy:{entry_number:'asc'}})
    assert.equal(entries.length,3);assert.deepEqual(entries.map(e=>e.lines.find(l=>l.account_id===acc.cash.id)).map(l=>Number(l.debit)-Number(l.credit)),[-100,80,-10])
    assert.equal((await flow.getCorrection(db,f.scope,f.id,a.id)).accountingStatus,'POSTED')
    await assert.rejects(db.$transaction(tx=>posting.assertCashEntryReversible(tx,f.scope,entries[0])),e=>e.status===409)
    await assert.rejects(db.$transaction(tx=>posting.assertCashEntryReversible(tx,f.scope,entries[1])),e=>e.status===409)
    assert.equal(b.sequence,2)
  }finally{await db.$disconnect()}
})
test('disabled accounting allows consecutive corrections without accounts; closed periods block later posting atomically',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db)
    await db.accountingPeriod.create({data:{company_id:f.company.id,year:2026,month:11,status:'CLOSED'}})
    await approve(db,f,'980');await approve(db,f,'970')
    await accounts(db,f)
    const posting=require('../src/services/accounting/cashClosurePosting')
    await assert.rejects(db.$transaction(tx=>posting.postClosureChain(tx,f.scope,f.id)),/cerrado/)
    assert.equal(await db.journalEntry.count({where:{company_id:f.company.id}}),0)
  }finally{await db.$disconnect()}
})
test('pending proposals protect base reversals; cancelled proposals restore the previous reversal capability',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db);await accounts(db,f)
    const posting=require('../src/services/accounting/cashClosurePosting')
    await db.$transaction(tx=>posting.postClosureChain(tx,f.scope,f.id))
    const entry=await db.journalEntry.findFirst({where:{company_id:f.company.id}})
    const ctx=await flow.correctionContext(db,f.scope,f.id),input={reason:'Corrección',accountingDate:'2026-11-20',previousCorrectionId:null,lines:[{closurePaymentId:f.paymentId,correctedActual:'980'}],requestKey:randomUUID()}
    input.previewKey=(await flow.previewCorrection(db,f.scope,f.id,input)).previewKey
    const doc=await db.$transaction(tx=>flow.proposeCorrection(tx,f.scope,f.id,input))
    await assert.rejects(db.$transaction(tx=>posting.assertCashEntryReversible(tx,f.scope,entry)),e=>e.status===409)
    await db.$transaction(tx=>flow.cancelCorrection(tx,f.scope,f.id,doc.id,{reason:'Ya no corresponde',expectedUpdatedAt:doc.updatedAt,requestKey:randomUUID()}))
    await db.$transaction(tx=>posting.assertCashEntryReversible(tx,f.scope,entry))
  }finally{await db.$disconnect()}
})
test('an open period remains locked until the posting transaction finishes',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db)
    const p=await db.accountingPeriod.create({data:{company_id:f.company.id,year:2026,month:11}})
    await db.$transaction(async tx=>{
      await require('../src/services/accounting/core').assertPeriodOpen(tx,'2026-11-20',f.company.id)
      await assert.rejects(db.$transaction(async other=>{
        await other.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'")
        await other.accountingPeriod.update({where:{id:p.id},data:{status:'CLOSED'}})
      }))
    })
  }finally{await db.$disconnect()}
})
test('accounting enabled approvals roll back entirely on a closed period, and freeze the first effective account pair',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),a=await accounts(db,f)
    await db.companyModule.update({where:{company_id_module_code:{company_id:f.company.id,module_code:'accounting'}},data:{status:'ACTIVE'}})
    await db.accountingPeriod.create({data:{company_id:f.company.id,year:2026,month:11,status:'CLOSED'}})
    await assert.rejects(approve(db,f,'980'),/cerrado/)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_closure_corrections WHERE status='APPROVED'`)[0].n,0)
    assert.equal(await db.journalEntry.count(),0)
    await db.accountingPeriod.updateMany({where:{company_id:f.company.id},data:{status:'OPEN'}})
    const first=await approve(db,f,'980');assert.equal(first.accountingStatus,'POSTED')
    const newCash=await db.account.create({data:{company_id:f.company.id,code:'1111',name:'Caja nueva',type:'ASSET'}})
    await db.systemSetting.updateMany({where:{company_id:f.company.id,key:'accounting.defaultAccounts'},data:{value:JSON.stringify({cash:newCash.code,cashOverShort:a.difference.code})}})
    const next=await approve(db,f,'970')
    const entry=await db.journalEntry.findUnique({where:{id:next.journalEntryId},include:{lines:true}})
    assert.ok(entry.lines.some(l=>l.account_id===a.cash.id));assert.equal(entry.lines.some(l=>l.account_id===newCash.id),false)
  }finally{await db.$disconnect()}
})
test('a digital-only correction never creates a cash entry or requires cash accounts',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db,{kind:'BANK'})
    await db.companyModule.update({where:{company_id_module_code:{company_id:f.company.id,module_code:'accounting'}},data:{status:'ACTIVE'}})
    const doc=await approve(db,f,'980')
    assert.equal(doc.cashDelta,'0.00');assert.equal(doc.accountingStatus,'ZERO')
    assert.equal(await db.journalEntry.count(),0)
  }finally{await db.$disconnect()}
})
test('a zero original freezes accounts only at first monetary posting and refuses a reversed or inconsistent base',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db,{actual:'1000.00'}),doc=await approve(db,f,'980')
    assert.equal(doc.accountingStatus,'DEFERRED');assert.equal(await db.account.count({where:{company_id:f.company.id,code:'1110'}}),0)
    const a=await accounts(db,f),posting=require('../src/services/accounting/cashClosurePosting')
    await db.$transaction(tx=>posting.postClosureChain(tx,f.scope,f.id))
    const entries=await db.journalEntry.findMany({where:{company_id:f.company.id},include:{lines:true}})
    assert.equal(entries.length,1);assert.equal(entries[0].source_type,'CASH_CLOSURE_CORRECTION');assert.equal(Number(entries[0].lines.find(l=>l.account_id===a.cash.id).credit),20)
    const other=await fixture(db);await accounts(db,other)
    await db.$transaction(tx=>posting.postClosureChain(tx,other.scope,other.id))
    const entry=await db.journalEntry.findFirst({where:{company_id:other.company.id},include:{lines:true}})
    await db.$transaction(tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:other.company.id,branch_id:other.branch.id,date:'2026-11-20',description:'Anulación previa permitida',reversal_of_id:entry.id,lines:entry.lines.map(l=>({account_id:l.account_id,debit:l.credit,credit:l.debit}))}))
    await assert.rejects(db.$transaction(tx=>posting.postClosureChain(tx,other.scope,other.id)),/revertido/)
  }finally{await db.$disconnect()}
})
test('annual close and correction posting use the same lock order without a December deadlock',{skip:!url,timeout:120000},async()=>{
  const {db}=await qaSchema(url),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
  try{
    const f=await fixture(db),a=await accounts(db,f),core=require('../src/services/accounting/core'),posting=require('../src/services/accounting/cashClosurePosting')
    await db.$transaction(tx=>posting.postClosureChain(tx,f.scope,f.id))
    await approve(db,f,'980','2026-12-20')
    await db.$transaction(tx=>core.createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-02',description:'Ingreso QA',lines:[{account_id:a.cash.id,debit:100,credit:0},{account_id:f.accounts.income.id,debit:0,credit:100}]}))
    const mapping=Object.fromEntries(core.DEFAULT_ACCOUNT_KEYS.map(k=>[k,a.cash.code]));mapping.cashOverShort=a.difference.code
    await db.systemSetting.updateMany({where:{company_id:f.company.id,key:'accounting.defaultAccounts'},data:{value:JSON.stringify(mapping)}})
    for(let month=1;month<=12;month++)await db.accountingPeriod.upsert({where:{company_id_year_month:{company_id:f.company.id,year:2026,month}},create:{company_id:f.company.id,year:2026,month,status:'CLOSED'},update:{status:'CLOSED'}})
    const held=deferred(),release=deferred(),entered=deferred(),updated=deferred()
    const cash=db.$transaction(async tx=>{await core.lockAccountingCompany(tx,f.company.id);held.resolve();await release.promise;return posting.postClosureChain(tx,f.scope,f.id)},{timeout:20000})
    const cashSettled=cash.then(value=>({value}),error=>({error}))
    await held.promise
    const proxy=new Proxy(db,{get(target,p){if(p!=='$transaction')return target[p];return work=>db.$transaction(async tx=>{
      entered.resolve((await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid)
      const periods=new Proxy(tx.accountingPeriod,{get(model,method){if(method!=='update')return model[method];return async args=>{const result=await model.update(args);updated.resolve();return result}}})
      return work(new Proxy(tx,{get(client,prop){return prop==='accountingPeriod'?periods:client[prop]}}))
    },{timeout:20000})}})
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:proxy}},require.resolve('../src/modules/accounting/controller'),async http=>{
      const response=jsonResponse();let error
      const closing=http.closeYear({companyId:f.company.id,params:{year:'2026'},user:{sub:f.other.id}},response,e=>error=e)
      const pid=await entered.promise
      const advisoryWait=(async()=>{for(let i=0;i<200;i++){const [r]=await db.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND NOT granted) AS waiting`;if(r.waiting)return;await new Promise(r=>setTimeout(r,5))}throw Error('Annual close never reached lock boundary')})()
      await Promise.race([updated.promise,advisoryWait]);release.resolve()
      const [cashResult]=await Promise.all([cashSettled,closing])
      assert.equal(error,undefined,error?.message);assert.equal(response.statusCode,201)
      assert.ok(cashResult.error instanceof core.AccountingError,'cash correction remains blocked by the closed December period')
      assert.equal((await db.accountingPeriod.findUnique({where:{company_id_year_month:{company_id:f.company.id,year:2026,month:12}}})).status,'CLOSED')
    })
  }finally{await db.$disconnect()}
})
