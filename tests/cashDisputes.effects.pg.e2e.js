const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture,insertCase}=require('./helpers/cashDisputesQa.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
const confirm=(db,f,id,raw)=>db.$transaction(tx=>require('../src/modules/cash-closure/disputes.effects').confirmDisputeEffect(tx,f.scope,id,raw))
const command=(extra={})=>({kind:'BANK_DEBIT',principal:'100.00',fee:'5.00',effectiveOn:'2026-11-23',reference:'BANCO-RETIRO-001',evidence:{identifier:'Estado de cuenta noviembre / línea 15'},expectedVersion:1,requestKey:randomUUID(),...extra})
async function configure(db,f){
  await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'DISABLED'}})
  const dispute=await db.account.create({data:{company_id:f.company.id,code:'1190',name:'Fondos en disputa',type:'ASSET'}})
  await db.$executeRaw`INSERT INTO cash_dispute_settings(company_id,dispute_account_id,fee_account_id,updated_by_id,reason) VALUES(${f.company.id}::uuid,${dispute.id},${f.accounts.fee.id},${f.user.id}::uuid,'Configuración QA')`
  return dispute
}
test('a confirmed bank withdrawal preserves the original receipt and closed-turn money, and retries return one effect',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f),dispute=await configure(db,f)
    const before=await db.customerPayment.findUnique({where:{id:f.paymentId}}),events=await db.cashMoneyEvent.count(),raw=command()
    const result=await confirm(db,f,id,raw),again=await confirm(db,f,id,raw)
    assert.deepEqual(again,result);assert.equal(result.withdrawn,'100.00');assert.equal(result.fees,'5.00');assert.equal(result.version,3)
    assert.deepEqual(await db.customerPayment.findUnique({where:{id:f.paymentId}}),before)
    assert.equal(await db.cashMoneyEvent.count(),events);assert.equal(await db.journalEntry.count(),0)
    const [effect]=await db.$queryRaw`SELECT * FROM cash_dispute_events WHERE dispute_id=${id}::uuid AND kind='BANK_DEBIT'`
    assert.equal(effect.accounting_status,'DEFERRED');assert.equal(effect.payload.accounting.disputeAccountId,dispute.id)
    assert.equal(effect.payload.accounting.fundingAccountId,f.accounts.bank.id)
    assert.equal(result.history.find(e=>e.kind==='BANK_DEBIT').payload.accounting,undefined)
    await assert.rejects(confirm(db,f,id,{...raw,fee:'6.00'}),{code:'DISPUTE_ATTEMPT_CONFLICT'})
    await assert.rejects(confirm(db,{...f,scope:{...f.scope,can:{...f.scope.can,movements:false}}},id,raw),{status:403})
  }finally{await db.$disconnect()}
})
test('a chosen accounting date is retained while accounting is disabled and always needs a reason when different',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f);await configure(db,f)
    const raw=command({accountingDate:'2026-11-24'})
    await assert.rejects(confirm(db,f,id,raw),{code:'DISPUTE_INPUT_INVALID'})
    assert.equal(await db.cashDisputeEvent.count(),0)
    await confirm(db,f,id,{...raw,dateChangeReason:'Registro en la fecha de revisión contable'})
    const [effect]=await db.$queryRaw`SELECT * FROM cash_dispute_events WHERE dispute_id=${id}::uuid AND kind='BANK_DEBIT'`
    const inspection=await require('../src/services/accounting/cashDisputePosting').inspectDisputeAccounting(db,f.scope,id)
    assert.equal(inspection.sources[0].accountingOn,null);assert.equal(inspection.sources[0].suggestedAccountingOn,'2026-11-24')
    const receivables=await db.account.create({data:{company_id:f.company.id,code:'1120',name:'Clientes',type:'ASSET'}})
    await db.companyModule.updateMany({where:{company_id:f.company.id,module_code:'accounting'},data:{status:'ACTIVE'}})
    await db.$transaction(tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'SALE_PAYMENT',source_id:f.paymentId,description:'Cobro original QA',lines:[{account_id:f.accounts.clearing.id,debit:100},{account_id:receivables.id,credit:100}]}))
    await db.accountingPeriod.updateMany({where:{company_id:f.company.id,year:2026,month:11},data:{status:'CLOSED'}})
    await db.$transaction(tx=>require('../src/services/accounting/cashDisputePosting').postDisputeEffect(tx,f.scope,effect.id,{accountingDate:'2026-12-01',dateChangeReason:'Contabilización explícita en el siguiente período abierto'}))
    const [posted]=await db.$queryRaw`SELECT * FROM cash_dispute_events WHERE id=${effect.id}::uuid`
    assert.equal(posted.accounting_on.toISOString().slice(0,10),'2026-12-01')
    assert.equal(posted.payload.requestedAccountingDate,'2026-11-24')
    assert.equal(posted.payload.requestedDateReason,'Registro en la fecha de revisión contable')
  }finally{await db.$disconnect()}
})
test('accounting-active withdrawal commits its exact journal atomically and a closed period leaves no effect or command',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f),dispute=await configure(db,f)
    const receivables=await db.account.create({data:{company_id:f.company.id,code:'1120',name:'Clientes',type:'ASSET'}})
    await db.companyModule.upsert({where:{company_id_module_code:{company_id:f.company.id,module_code:'accounting'}},create:{company_id:f.company.id,module_code:'accounting',status:'ACTIVE'},update:{status:'ACTIVE'}})
    await db.$transaction(tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'SALE_PAYMENT',source_id:f.paymentId,description:'Cobro original QA',lines:[{account_id:f.accounts.clearing.id,debit:100},{account_id:receivables.id,credit:100}]}))
    await db.accountingPeriod.updateMany({where:{company_id:f.company.id,year:2026,month:11},data:{status:'CLOSED'}})
    const raw=command({accountingDate:'2026-11-23'})
    await assert.rejects(confirm(db,f,id,raw),/cerrado/)
    assert.equal(await db.cashDisputeEvent.count(),0);assert.equal(await db.cashDisputeCommand.count(),0)
    await db.accountingPeriod.updateMany({where:{company_id:f.company.id,year:2026,month:11},data:{status:'OPEN'}})
    await confirm(db,f,id,raw)
    const entry=await db.journalEntry.findFirst({where:{source_type:'CASH_DISPUTE_EFFECT'},include:{lines:true}})
    assert.deepEqual(entry.lines.map(l=>[l.account_id,String(l.debit),String(l.credit)]).sort((a,b)=>a[0]-b[0]),[[f.accounts.bank.id,'0','105'],[f.accounts.fee.id,'5','0'],[dispute.id,'100','0']].sort((a,b)=>a[0]-b[0]))
    assert.equal(await db.journalEntry.count({where:{source_type:'SALE_PAYMENT'}}),1)
  }finally{await db.$disconnect()}
})
test('a standalone provider withholding reduces pending settlement once and cannot be settled again',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f);await configure(db,f)
    const api=require('../src/modules/cash-closure/settlements')
    await confirm(db,f,id,command({kind:'PROVIDER_WITHHOLDING',principal:'20',fee:'0'}))
    const pending=await api.pendingReceipts(db,f.scope)
    assert.equal(pending.items.find(i=>i.event_id===f.event.id).remaining,'80.00')
    const raw={paymentMethodId:f.card.id,net:'80',allocations:[{eventId:f.event.id,amount:'80'}],deductions:[],deposit:{reference:'DEPOSITO-80',depositedOn:'2026-11-23',totalAmount:'80'},requestKey:randomUUID()}
    await db.$transaction(tx=>api.createSettlement(tx,f.scope,raw))
    assert.equal((await api.pendingReceipts(db,f.scope)).items.some(i=>i.event_id===f.event.id),false)
    await assert.rejects(db.$transaction(tx=>api.createSettlement(tx,f.scope,{...raw,net:'1',allocations:[{eventId:f.event.id,amount:'1'}],requestKey:randomUUID()})),{code:'CASH_SETTLEMENT_ALLOCATION'})
    await assert.rejects(confirm(db,f,id,command({kind:'PROVIDER_WITHHOLDING',principal:'1',fee:'0',expectedVersion:3,reference:'RETENCION-EXCESO'})),{code:'DISPUTE_PROVIDER_BALANCE'})
    await assert.rejects(db.$transaction(async tx=>{
      const [deposit]=await tx.$queryRaw`INSERT INTO cash_bank_deposits(company_id,payment_method_id,version_id,reference,deposited_on,currency_code,total_amount,created_by_id)
        SELECT ${f.company.id}::uuid,${f.card.id},version_id,'DEPOSITO-SIN-SALDO','2026-11-23','GTQ',1,${f.user.id}::uuid FROM cash_bank_event_modes WHERE event_id=${f.event.id}::uuid RETURNING id`
      const [s]=await tx.$queryRaw`INSERT INTO cash_settlements(company_id,branch_id,deposit_id,currency_code,gross,refunds,deductions,net,created_by_id,request_key,request_hash)
        VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${deposit.id}::uuid,'GTQ',1,0,0,1,${f.user.id}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)}) RETURNING id`
      await tx.$executeRaw`INSERT INTO cash_settlement_allocations(settlement_id,event_id,amount) VALUES(${s.id}::uuid,${f.event.id}::uuid,1)`
    }),/cash_settlement_exceeds/)
    await assert.rejects(db.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,principal,economic_on,reference,actor_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,'PROVIDER_WITHHOLDING',1,'2026-11-23','SIN-SALDO',${f.user.id}::uuid)`,/dispute_provider_balance/)
  }finally{await db.$disconnect()}
})
test('the same provider balance cannot back two simultaneous withholdings, and foreign cases stay private',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f);await configure(db,f)
    const outcomes=await Promise.allSettled([confirm(db,f,id,command({kind:'PROVIDER_WITHHOLDING',fee:'0'})),confirm(db,f,id,command({kind:'PROVIDER_WITHHOLDING',fee:'0',reference:'OTRO-RETIRO'}))])
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'DISPUTE_VERSION_CONFLICT')
    assert.equal(await db.cashDisputeEvent.count({where:{kind:'PROVIDER_WITHHOLDING'}}),1)
    const other=await fixture(db)
    await assert.rejects(confirm(db,other,id,command()),{status:404})
  }finally{await db.$disconnect()}
})
test('settlement and withholding serialize on the original funds in either winner order',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    for(const winner of ['HOLD','SETTLE']){
      const f=await fixture(db),id=await insertCase(db,f);await configure(db,f)
      let entered,release
      const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
      const settle=tx=>require('../src/modules/cash-closure/settlements').createSettlement(tx,f.scope,{paymentMethodId:f.card.id,net:'100',allocations:[{eventId:f.event.id,amount:'100'}],deductions:[],deposit:{reference:'TODO-EL-SALDO',depositedOn:'2026-11-23',totalAmount:'100'},requestKey:randomUUID()})
      const hold=tx=>require('../src/modules/cash-closure/disputes.effects').confirmDisputeEffect(tx,f.scope,id,command({kind:'PROVIDER_WITHHOLDING',fee:'0'}))
      const first=db.$transaction(async tx=>{const result=await(winner==='HOLD'?hold(tx):settle(tx));entered();await gate;return result},{timeout:20000})
      try{
        await ready
        const second=db.$transaction(tx=>winner==='HOLD'?settle(tx):hold(tx),{timeout:20000})
        const rejected=assert.rejects(second,{code:winner==='HOLD'?'CASH_SETTLEMENT_ALLOCATION':'DISPUTE_PROVIDER_BALANCE'})
        release();await first;await rejected
      }finally{release()}
      assert.equal((await require('../src/modules/cash-closure/settlements').pendingReceipts(db,f.scope)).items.length,0)
      assert.equal(await db.cashMoneyEvent.count({where:{company_id:f.company.id}}),1)
    }
  }finally{await db.$disconnect()}
})
test('later withdrawals of one case retain its dispute asset when the company changes its default account',{skip:!url,timeout:240000},async()=>{
  const {db}=await qaSchema(url)
  try{
    const f=await fixture(db),id=await insertCase(db,f),original=await configure(db,f)
    const first=await confirm(db,f,id,command({principal:'20',fee:'0'}))
    const replacement=await db.account.create({data:{company_id:f.company.id,code:'1191',name:'Nuevo destino de reclamos',type:'ASSET'}})
    await db.$executeRaw`UPDATE cash_dispute_settings SET dispute_account_id=${replacement.id},revision=revision+1 WHERE company_id=${f.company.id}::uuid`
    const result=await confirm(db,f,id,command({principal:'30',fee:'0',expectedVersion:first.version,reference:'SEGUNDO-RETIRO'}))
    assert.equal(result.withdrawn,'50.00')
    const rows=await db.$queryRaw`SELECT payload#>>'{accounting,disputeAccountId}' AS account FROM cash_dispute_events WHERE dispute_id=${id}::uuid AND kind='BANK_DEBIT' ORDER BY created_at,id`
    assert.deepEqual(rows.map(r=>Number(r.account)),[original.id,original.id])
  }finally{await db.$disconnect()}
})
