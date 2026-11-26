const test=require('node:test'),assert=require('node:assert/strict')
const {qaSchema,fixture,insertCase}=require('./helpers/cashDisputesQa.cjs')
const posting=require('../src/services/accounting/cashDisputePosting')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
async function setup(db){
  const f=await fixture(db),id=await insertCase(db,f)
  const dispute=await db.account.create({data:{company_id:f.company.id,code:'1190',name:'Fondos en disputa',type:'ASSET'}})
  const receivables=await db.account.create({data:{company_id:f.company.id,code:'1120',name:'Clientes',type:'ASSET'}})
  await db.companyModule.upsert({where:{company_id_module_code:{company_id:f.company.id,module_code:'accounting'}},create:{company_id:f.company.id,module_code:'accounting',status:'ACTIVE'},update:{status:'ACTIVE'}})
  await db.$transaction(tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'SALE_PAYMENT',source_id:f.paymentId,description:'Cobro original QA',lines:[{account_id:f.accounts.clearing.id,debit:100},{account_id:receivables.id,credit:100}]}))
  const config={fundingAccountId:f.accounts.bank.id,disputeAccountId:dispute.id,feeAccountId:f.accounts.fee.id}
  const [effect]=await db.$queryRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,fee,economic_on,reference,payload,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',100,5,'2026-11-22','QA-RETIRO',${JSON.stringify({accounting:config})}::jsonb,${f.user.id}::uuid) RETURNING id`
  return {...f,id,effect,dispute,receivables}
}
test('posting a dispute withdrawal is source-idempotent and never edits or reposts the original receipt',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await setup(db),before=await db.journalEntry.findMany({include:{lines:true}})
    const run=()=>db.$transaction(tx=>posting.postDisputeEffect(tx,f.scope,f.effect.id,{accountingDate:'2026-11-23',dateChangeReason:'Conciliación bancaria en período abierto'}))
    const result=await run(),again=await run()
    assert.equal(result.entryId,again.entryId)
    const entry=await db.journalEntry.findUnique({where:{id:result.entryId},include:{lines:true}})
    assert.equal(entry.source_type,'CASH_DISPUTE_EFFECT')
    await assert.rejects(db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,fee,economic_on,reference,actor_id,accounting_status,journal_entry_id) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_DEBIT',0,1,'2026-11-23','ASIENTO-AJENO',${f.user.id}::uuid,'POSTED',${entry.id}::uuid)`,/dispute_initial_accounting_state/)
    assert.deepEqual(entry.lines.sort((a,b)=>a.account_id-b.account_id).map(l=>[l.account_id,String(l.debit),String(l.credit)]),[[f.accounts.bank.id,'0','105'],[f.accounts.fee.id,'5','0'],[f.dispute.id,'100','0']].sort((a,b)=>a[0]-b[0]))
    assert.deepEqual(await db.journalEntry.findMany({where:{id:{in:before.map(e=>e.id)}},include:{lines:true}}),before)
    const foreign=await fixture(db)
    await assert.rejects(db.$transaction(tx=>posting.postDisputeEffect(tx,foreign.scope,f.effect.id,{accountingDate:'2026-11-23',dateChangeReason:'Conciliación bancaria en período abierto'})),{status:404})
  }finally{await db.$disconnect()}
})
test('a closed accounting period rolls back every new dispute entry and preserves the pending source',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await setup(db)
    await db.accountingPeriod.updateMany({where:{company_id:f.company.id,year:2026,month:11},data:{status:'CLOSED'}})
    await assert.rejects(db.$transaction(tx=>posting.postDisputeEffect(tx,f.scope,f.effect.id,{accountingDate:'2026-11-23',dateChangeReason:'Conciliación bancaria en período abierto'})),/cerrado/)
    assert.equal(await db.journalEntry.count({where:{source_type:'CASH_DISPUTE_EFFECT'}}),0)
    const [event]=await db.$queryRaw`SELECT accounting_status FROM cash_dispute_events WHERE id=${f.effect.id}::uuid`
    assert.equal(event.accounting_status,'DEFERRED')
  }finally{await db.$disconnect()}
})
test('generic reversal locks original resources before accounting and protects disputed receipts and dispute entries',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await setup(db),entry=await db.journalEntry.findFirst({where:{company_id:f.company.id,source_type:'SALE_PAYMENT'}})
    await assert.rejects(db.$transaction(async tx=>{
      const resources=await posting.prepareDisputeEntryReversal(tx,f.scope,entry)
      assert.deepEqual(resources.eventIds,[f.event.id])
      await require('../src/services/accounting/core').lockAccountingCompany(tx,f.company.id)
      await posting.assertDisputeEntryReversible(tx,f.scope,entry,resources)
    }),{code:'DISPUTE_ACCOUNTING_PROTECTED'})
    await assert.rejects(db.$transaction(tx=>posting.prepareDisputeEntryReversal(tx,f.scope,{...entry,source_type:'CASH_DISPUTE_EFFECT'})),{code:'DISPUTE_ACCOUNTING_PROTECTED'})
    const legacy=await db.journalEntry.update({where:{id:entry.id},data:{branch_id:null}})
    const resources=await db.$transaction(tx=>posting.prepareDisputeEntryReversal(tx,f.scope,legacy))
    assert.equal(resources.branchId,f.branch.id)
    await assert.rejects(db.$transaction(tx=>posting.assertDisputeEntryReversible(tx,f.scope,legacy,resources)),{code:'DISPUTE_ACCOUNTING_PROTECTED'})
  }finally{await db.$disconnect()}
})
test('changing company currency never silently converts a frozen dispute source',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await setup(db)
    await db.systemSetting.updateMany({where:{company_id:f.company.id,key:'currency_code'},data:{value:'USD'}})
    await assert.rejects(db.$transaction(tx=>posting.postDisputeEffect(tx,f.scope,f.effect.id,{accountingDate:'2026-11-23',dateChangeReason:'Conciliación bancaria'})),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
    assert.equal(await db.journalEntry.count({where:{source_type:'CASH_DISPUTE_EFFECT'}}),0)
  }finally{await db.$disconnect()}
})
test('a disposition cannot move principal to a different dispute asset than its withdrawal',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await setup(db),other=await db.account.create({data:{company_id:f.company.id,code:'1191',name:'Otra cuenta de disputas',type:'ASSET'}})
    await db.$transaction(tx=>posting.postDisputeEffect(tx,f.scope,f.effect.id,{accountingDate:'2026-11-23',dateChangeReason:'Conciliación bancaria'}))
    async function approve(kind,payload,version){
      const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${kind},${JSON.stringify(payload)}::jsonb,${'a'.repeat(64)},${version},${f.user.id}::uuid) RETURNING id`
      await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`;return p.id
    }
    await approve('RESULT',{won:'0',lost:'100'},1)
    await db.$executeRaw`UPDATE cash_payment_disputes SET status='LOST',lost=100,version=2 WHERE id=${f.id}::uuid`
    const p=await approve('DISPOSITION',{customerPrincipal:'0',absorbedPrincipal:'100',accounting:{disputeAccountId:other.id}},2)
    await db.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,kind,principal,account_id) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${p}::uuid,'ABSORBED',100,${f.accounts.fee.id})`
    await assert.rejects(db.$transaction(tx=>posting.postDisputeDisposition(tx,f.scope,p,{accountingDate:'2026-11-23'})),{code:'DISPUTE_ACCOUNTING_PROVENANCE'})
  }finally{await db.$disconnect()}
})
test('the existing posting batch never posts a returned alias credit note as another refund when its reference is empty',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),keys=['cash','bank','receivables','sales','salesReturns','cogs','inventory','payables','ivaDebit','ivaCredit','pequenoTax','pequenoTaxExpense','currentEarnings','retainedEarnings'],map={}
    for(const [index,key] of keys.entries()){
      const a=await db.account.create({data:{company_id:f.company.id,code:'QA'+index,name:key,type:['sales','salesReturns'].includes(key)?'INCOME':['cogs','pequenoTaxExpense'].includes(key)?'EXPENSE':['payables','ivaDebit','pequenoTax'].includes(key)?'LIABILITY':['currentEarnings','retainedEarnings'].includes(key)?'EQUITY':'ASSET'}});map[key]=a.code
    }
    await db.systemSetting.create({data:{company_id:f.company.id,key:'accounting.defaultAccounts',value:JSON.stringify(map)}})
    const completed=await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
    const sale=await db.$transaction(async tx=>{
      const sale=await tx.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:completed.id,payment_method_id:f.card.id,total:100,adjusted_total:100,items:0,created_by:f.user.id,cash_register_session_id:f.period.id}})
      const session=await require('../src/services/cashSessionBoundary').lockScopedSession(tx,f.scope,f.period.id)
      await require('../src/modules/cash-closure/events').recordMoneyEvent(tx,f.scope,{session,sourceType:'SALE',sourceId:sale.id});return sale
    })
    const rs=await db.returnStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
    await db.sale.update({where:{id:sale.id},data:{adjusted_total:60,total_returned:40}})
    const returned=await db.return.create({data:{sale_id:sale.id,status_id:rs.id,total_refund:40}})
    const settlement=await db.returnSettlement.create({data:{return_id:returned.id,kind:'CUSTOMER_CREDIT',amount:40,registered_by:f.user.id,idempotency_key:require('node:crypto').randomUUID()}})
    const note=await db.customerPayment.create({data:{branch_id:f.branch.id,customer_id:f.customer.id,amount:40,kind:'CREDIT_NOTE',registered_by:f.user.id}})
    await db.$transaction(tx=>require('../src/modules/cash-closure/disputes.refunds').recordReturnedSaleCredit(tx,f.scope,settlement.id,note.id))
    await require('../src/services/accounting/postingEngine').postPendingOperations(db,f.user.id,f.company.id)
    assert.equal(await db.journalEntry.count({where:{source_type:'RETURN',source_id:returned.id}}),1)
    assert.equal(await db.journalEntry.count({where:{source_type:'SALE_PAYMENT',source_id:note.id}}),0)
  }finally{await db.$disconnect()}
})
test('an absorbed loss and a later recovery follow the frozen expense account, with separate dates per source',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await setup(db),loss=await db.account.create({data:{company_id:f.company.id,code:'6190',name:'Pérdidas asumidas',type:'EXPENSE'}})
    async function approve(kind,payload,version){
      const [p]=await db.$queryRaw`INSERT INTO cash_dispute_proposals(dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${kind},${JSON.stringify(payload)}::jsonb,${'a'.repeat(64)},${version},${f.user.id}::uuid) RETURNING id`
      await db.$executeRaw`UPDATE cash_dispute_proposals SET status='APPROVED',decided_by_id=${f.other.id}::uuid,decided_at=now() WHERE id=${p.id}::uuid`;return p.id
    }
    await approve('RESULT',{won:'0',lost:'100'},1)
    await db.$executeRaw`UPDATE cash_payment_disputes SET status='LOST',lost=100,version=2 WHERE id=${f.id}::uuid`
    const proposal=await approve('DISPOSITION',{customerPrincipal:'0',absorbedPrincipal:'100',accounting:{disputeAccountId:f.dispute.id}},2)
    const [lot]=await db.$queryRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,proposal_id,kind,principal,account_id) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${proposal}::uuid,'ABSORBED',100,${loss.id}) RETURNING id`
    const [recovery]=await db.$queryRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,payload,actor_id) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'BANK_RECOVERY',40,'2026-11-24','QA-RECUPERACION',${JSON.stringify({accounting:{fundingAccountId:f.accounts.bank.id,disputeAccountId:f.dispute.id}})}::jsonb,${f.user.id}::uuid) RETURNING id`
    await db.$executeRaw`INSERT INTO cash_dispute_lots(dispute_id,company_id,branch_id,event_id,target_lot_id,kind,principal) VALUES(${f.id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${recovery.id}::uuid,${lot.id}::uuid,'RECOVERED',40)`
    const dates={[f.effect.id]:{accountingDate:'2026-11-23',dateChangeReason:'Conciliación bancaria'},[proposal]:{accountingDate:'2026-11-23'},[recovery.id]:{accountingDate:'2026-11-24'}}
    await db.$transaction(tx=>posting.postDisputeChain(tx,{...f.scope,can:{...f.scope.can,post:true}},f.id,{accountingDateBySource:dates}))
    const entries=await db.journalEntry.findMany({where:{company_id:f.company.id,source_type:{in:['CASH_DISPUTE_EFFECT','CASH_DISPUTE_DISPOSITION']}},include:{lines:true}})
    assert.equal(entries.length,3)
    assert.equal(String(entries.find(e=>e.source_id===proposal).lines.find(l=>l.account_id===loss.id).debit),'100')
    assert.equal(String(entries.find(e=>e.source_id===recovery.id).lines.find(l=>l.account_id===loss.id).credit),'40')
    assert.equal(await db.customerRecoveryCredit.count(),0)
  }finally{await db.$disconnect()}
})
