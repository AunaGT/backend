const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const flow=require('../src/modules/cash-closure/disputes'),resolutions=require('../src/modules/cash-closure/disputes.resolutions')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
const {run,effect,movement,credit,act,lostCase}=require('./helpers/cashDisputesFlow.cjs')
const restriction=async(db,f,id)=>(await db.$queryRaw`SELECT held::text,retired::text FROM customer_receipt_restrictions WHERE payment_id=${f.paymentId}::uuid AND dispute_id=${id}::uuid`)[0]
const lots=async(db,id)=>(await db.$queryRaw`SELECT kind,principal::text,target_lot_id IS NOT NULL AS targeted FROM cash_dispute_lots WHERE dispute_id=${id}::uuid ORDER BY created_at,kind`).map(l=>[l.kind,l.principal])

test('recovering from the customer cancels only the free receipt balance and charges the applied rest',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db)
  assert.deepEqual(await restriction(db,f,doc.id),{held:'40.00',retired:'0.00'})
  const step=await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'100',absorbedPrincipal:'0',dueOn:'2026-12-31',reason:'El cliente reconoce el contracargo'})
  assert.deepEqual(step.preview.payload.plan,{retired:'40.00',charged:'60.00',absorbed:'0.00',total:'100.00'})
  await assert.rejects(step.decide({...f.reviewer,can:{...f.reviewer.can,charge:false}}),{status:403})
  const resolved=await step.decide()
  assert.equal(resolved.charged,'60.00');assert.equal(resolved.disposed,'100.00');assert.equal(resolved.unresolved,'0.00')
  assert.deepEqual(await step.decide(),resolved,'a lost response replays the same decision')
  assert.deepEqual(await restriction(db,f,doc.id),{held:'0.00',retired:'40.00'})
  assert.deepEqual(await lots(db,doc.id),[['CUSTOMER_CHARGE','60.00'],['RECEIPT_RETIRED','40.00']])
  const [charge]=await db.$queryRaw`SELECT reference,amount::text,due_on::text,customer_id FROM customer_dispute_charges WHERE dispute_id=${doc.id}::uuid`
  assert.equal(charge.amount,'60.00');assert.equal(charge.due_on,'2026-12-31');assert.equal(charge.customer_id,f.customer.id);assert.match(charge.reference,/^CC-.+-000001$/)
  assert.equal(await credit(db,f),0,'the free balance is not usable twice')
  assert.equal(await db.journalEntry.count(),0,'accounting is off, nothing is posted')

  // The bank returns everything: the charge is cancelled first and the receipt balance comes back.
  const recovered=await effect(db,f,doc.id,movement('BANK_RECOVERY','100.00',resolved.version))
  assert.equal(recovered.recovered,'100.00')
  const [{lotId}]=await db.$queryRaw`SELECT id AS "lotId" FROM cash_dispute_lots WHERE dispute_id=${doc.id}::uuid AND kind='CUSTOMER_CHARGE'`
  assert.equal((await resolutions.chargeOutstanding(db,lotId)).outstanding.toFixed(2),'0.00')
  assert.deepEqual(await restriction(db,f,doc.id),{held:'0.00',retired:'0.00'})
  assert.equal(await credit(db,f),40)
  assert.equal(Number((await db.$queryRaw`SELECT count(*)::int AS n FROM customer_recovery_credits WHERE dispute_id=${doc.id}::uuid`)[0].n),0,'nothing was paid, so no credit is created')
 }finally{await db.$disconnect()}
})

test('absorbing the loss keeps the customer balance and a later recovery reverses only that loss',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db)
  const resolved=await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'0',absorbedPrincipal:'100',reason:'La empresa asume la pérdida'})).decide()
  assert.equal(resolved.charged,'0.00');assert.deepEqual(await restriction(db,f,doc.id),{held:'0.00',retired:'0.00'})
  assert.equal(await credit(db,f),40,'nothing of the customer balance is cancelled')
  assert.equal(Number((await db.$queryRaw`SELECT count(*)::int AS n FROM customer_dispute_charges WHERE dispute_id=${doc.id}::uuid`)[0].n),0)
  await effect(db,f,doc.id,movement('BANK_RECOVERY','30.00',resolved.version))
  const [lot]=await db.$queryRaw`SELECT l.principal::text,t.kind FROM cash_dispute_lots l JOIN cash_dispute_lots t ON t.id=l.target_lot_id WHERE l.dispute_id=${doc.id}::uuid AND l.kind='RECOVERED'`
  assert.deepEqual(lot,{principal:'30.00',kind:'ABSORBED'})
 }finally{await db.$disconnect()}
})

test('a loss that the bank has not withdrawn cannot be disposed, and dispositions cannot exceed the withdrawn loss',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const pending=await lostCase(db,{withdraw:false})
  await assert.rejects(flow.previewDisputeAction(db,pending.f.scope,pending.doc.id,{kind:'DISPOSITION',payload:{customerPrincipal:'0',absorbedPrincipal:'1',reason:'Prueba'},expectedVersion:pending.doc.version}),{code:'DISPUTE_DISPOSITION_EXCEEDS'})
  const {f,doc}=await lostCase(db)
  await assert.rejects(flow.previewDisputeAction(db,f.scope,doc.id,{kind:'DISPOSITION',payload:{customerPrincipal:'60',absorbedPrincipal:'40.01',reason:'Prueba'},expectedVersion:doc.version}),{code:'DISPUTE_DISPOSITION_EXCEEDS'})
 }finally{await db.$disconnect()}
})

test('with accounting on, the disposition and the later recovery post balanced entries to their frozen accounts',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc,accounts}=await lostCase(db,{active:true})
  const balance=async(type,id)=>{const e=await db.journalEntry.findFirst({where:{source_type:type,source_id:id},include:{lines:true}});return Object.fromEntries(e.lines.map(l=>[l.account_id,l.debit.sub(l.credit).toFixed(2)]))}
  const step=await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'100',absorbedPrincipal:'0',dueOn:'2026-12-31',reason:'El cliente reconoce el contracargo'})
  const resolved=await step.decide()
  assert.deepEqual(await balance('CASH_DISPUTE_DISPOSITION',step.proposal.id),{[accounts.receivables.id]:'60.00',[accounts.advances.id]:'40.00',[accounts.dispute.id]:'-100.00'})
  await effect(db,f,doc.id,movement('BANK_RECOVERY','100.00',resolved.version))
  const [event]=await db.$queryRaw`SELECT id FROM cash_dispute_events WHERE dispute_id=${doc.id}::uuid AND kind='BANK_RECOVERY'`
  assert.deepEqual(await balance('CASH_DISPUTE_EFFECT',event.id),{[f.accounts.bank.id]:'100.00',[accounts.receivables.id]:'-60.00',[accounts.advances.id]:'-40.00'})
 }finally{await db.$disconnect()}
})

test('a forgiven and partly paid charge: a later recovery credits only what was paid and reverses the forgiven loss',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db,{applied:'100'})
  const disposed=await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'60',absorbedPrincipal:'40',dueOn:'2026-12-31',reason:'Reparto acordado'})).decide()
  assert.equal(disposed.charged,'60.00')
  const [charge]=await db.$queryRaw`SELECT id,lot_id FROM customer_dispute_charges WHERE dispute_id=${doc.id}::uuid`
  // El cliente pagó Q20 con otro recibo: cartera lo aplica al cargo pendiente.
  const paid=await run(db,tx=>require('../src/modules/receivables').applyPayment(tx,{...f.scope,customerId:f.customer.id,amount:20,paymentMethodId:f.card.id,cashRegisterSessionId:f.period.id}))
  assert.deepEqual(paid.applications,[{documentType:'DISPUTE_CHARGE',documentId:charge.id,amount:20}])
  const reviewer={...f.reviewer,can:{...f.reviewer.can,adjust:true}}
  await assert.rejects(act(db,f,doc.id,'FORGIVE',{lotId:charge.lot_id,amount:'40.01',reason:'Condonación'}),{code:'DISPUTE_ADJUSTMENT_EXCEEDS'},'only the unpaid Q40 can be forgiven')
  const step=await act(db,f,doc.id,'FORGIVE',{lotId:charge.lot_id,amount:'40',reason:'El cliente no puede cubrir el resto'})
  await assert.rejects(step.decide(),{status:403},'forgiving needs receivables adjustment authority')
  const forgiven=await step.decide(reviewer)
  assert.equal(forgiven.charged,'60.00','the charge document keeps its history')
  assert.equal((await resolutions.chargeOutstanding(db,charge.lot_id)).outstanding.toFixed(2),'0.00')
  await effect(db,f,doc.id,movement('BANK_RECOVERY','60.00',forgiven.version))
  const [credit]=await db.$queryRaw`SELECT coalesce(sum(amount),0)::text AS amount FROM customer_recovery_credits WHERE dispute_id=${doc.id}::uuid`
  assert.equal(credit.amount,'20.00','only the paid part becomes a customer credit')
  const [reversed]=await db.$queryRaw`SELECT coalesce(sum(l.principal),0)::text AS amount FROM cash_dispute_lots l JOIN cash_dispute_lots t ON t.id=l.target_lot_id WHERE l.dispute_id=${doc.id}::uuid AND l.kind='RECOVERED' AND t.kind='ABSORBED'`
  assert.equal(reversed.amount,'40.00','the forgiven and absorbed loss is reversed, not given away')
 }finally{await db.$disconnect()}
})

test('a correction compensates a wrong resolution and frees that principal for a new one',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db,{applied:'100'})
  await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'0',absorbedPrincipal:'100',reason:'Error: se asumió todo'})).decide()
  const [lot]=await db.$queryRaw`SELECT id FROM cash_dispute_lots WHERE dispute_id=${doc.id}::uuid AND kind='ABSORBED'`
  const reviewer={...f.reviewer,can:{...f.reviewer.can,adjust:true}}
  const corrected=await (await act(db,f,doc.id,'CORRECT',{lotId:lot.id,amount:'60',reason:'Parte correspondía al cliente'})).decide(reviewer)
  assert.equal(corrected.disposed,'40.00');assert.equal(corrected.unresolved,'60.00')
  const again=await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'60',absorbedPrincipal:'0',dueOn:'2026-12-31',reason:'Cargo correcto'})).decide()
  assert.equal(again.charged,'60.00');assert.equal(again.unresolved,'0.00')
 }finally{await db.$disconnect()}
})

test('balance released back to the receipt stays held while the customer still owes the charge',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db)
  await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'100',absorbedPrincipal:'0',dueOn:'2026-12-31',reason:'El cliente reconoce el contracargo'})).decide()
  assert.equal(await credit(db,f),0)
  // La venta pagada con este recibo se anula y devuelve Q60 al recibo.
  await run(db,async tx=>{
   await tx.$executeRaw`DELETE FROM sale_payment_entries WHERE customer_payment_id=${f.paymentId}::uuid`
   await require('../src/modules/cash-closure/disputes.receipts').refreshReceiptRestrictions(tx,f.scope,[f.paymentId])
  })
  assert.deepEqual(await restriction(db,f,doc.id),{held:'60.00',retired:'40.00'})
  assert.equal(await credit(db,f),0,'the customer cannot spend the released money while owing the Q60 charge')
  await assert.rejects(run(db,tx=>tx.$executeRaw`DELETE FROM sale_payment_entries WHERE customer_payment_id=${f.paymentId}::uuid`).then(()=>run(db,tx=>tx.$executeRaw`UPDATE customer_receipt_restrictions SET held=0,version=version+1 WHERE payment_id=${f.paymentId}::uuid`)),/dispute_receipt_reservation_stale/)
 }finally{await db.$disconnect()}
})

test('a provider recovery inside a settlement after the resolution credits its lots on the single settlement entry',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc,accounts}=await lostCase(db,{active:true})
  // Otro cobro del mismo medio, recibido antes de emitir el cargo: queda como anticipo y se liquida aparte.
  const payment=await run(db,tx=>require('../src/modules/receivables').applyPayment(tx,{...f.scope,customerId:f.customer.id,amount:50,paymentMethodId:f.card.id,cashRegisterSessionId:f.period.id,allowAdvance:true}))
  await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'100',absorbedPrincipal:'0',dueOn:'2026-12-31',reason:'El cliente reconoce el contracargo'})).decide()
  const [later]=await db.$queryRaw`SELECT * FROM cash_money_events WHERE source_id=${payment.paymentId}::uuid`
  await run(db,tx=>require('../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-24',source_type:'CUSTOMER_ADVANCE',source_id:payment.paymentId,description:'Otro cobro',lines:[{account_id:f.accounts.clearing.id,debit:'50.00'},{account_id:accounts.advances.id,credit:'50.00'}]}))
  const result=await run(db,tx=>require('../src/modules/cash-closure/settlements').createSettlement(tx,{...f.scope,canDisputeMovements:true},{paymentMethodId:f.card.id,requestKey:randomUUID(),net:'150.00',
   deposit:{reference:randomUUID(),depositedOn:'2026-11-24',totalAmount:'150.00'},allocations:[{eventId:later.id,amount:'50.00'}],recoveries:[{disputeId:doc.id,amount:'100.00'}]}))
  const entry=await db.journalEntry.findUnique({where:{id:result.settlement.journal_entry_id},include:{lines:true}})
  const byAccount={};for(const l of entry.lines)byAccount[l.account_id]=(Number(byAccount[l.account_id]||0)+Number(l.debit.sub(l.credit))).toFixed(2)
  assert.deepEqual(byAccount,{[f.accounts.bank.id]:'150.00',[f.accounts.clearing.id]:'-50.00',[accounts.receivables.id]:'-60.00',[accounts.advances.id]:'-40.00'})
  const [{lotId}]=await db.$queryRaw`SELECT id AS "lotId" FROM cash_dispute_lots WHERE dispute_id=${doc.id}::uuid AND kind='CUSTOMER_CHARGE'`
  assert.equal((await resolutions.chargeOutstanding(db,lotId)).outstanding.toFixed(2),'0.00')
  assert.deepEqual(await restriction(db,f,doc.id),{held:'0.00',retired:'0.00'})
 }finally{await db.$disconnect()}
})
