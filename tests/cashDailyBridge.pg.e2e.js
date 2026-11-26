const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDailyQa.cjs'),{countAndFinalize}=require('./helpers/cashDailyScenario.cjs')
const url=process.env.AUNA_CASH_DAILY_QA_URL
test('operational cash bridge follows real custody documents through two registers and mixed inherited float',{skip:!url,timeout:180000},async t=>{
  const qa=await qaSchema(url),{db}=qa
  try{for(const shortage of [0,-1])await t.test('balanced custody flow with accepted difference '+shortage,async()=>{
    const f=await fixture(db),c=require('../src/modules/cash-closure/custody'),day='2026-01-03'
    await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'DISABLED'}})
    const run=fn=>db.$transaction(fn,{timeout:20000}),staff={...f.scope,canOperateOwn:true,canOperateTeam:true,canReceive:true},receiver={...staff,userId:f.other.id}
    const safe=await require('./helpers/cashCustodyQa.cjs').custody(db,f)
    const close=id=>db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${id}::uuid`
    const open=(register,amount,date=day)=>run(async tx=>require('../src/services/cashEventAdoption').openEventSession(tx,f.scope,await require('../src/services/cashSessionBoundary').lockScopedRegister(tx,f.scope,register.id),{openingFloat:amount,notes:null,now:new Date(date+'T12:00:00Z')}))
    const pay=(session,amount)=>run(tx=>require('../src/modules/receivables').applyPayment(tx,{...f.scope,customerId:f.customer.id,amount,paymentMethodId:f.method.id,cashRegisterSessionId:session.id,allowAdvance:true}))
    const hand=(session,delivered,retained)=>run(tx=>c.handoverTurn(tx,staff,session.id,{requestKey:randomUUID(),deliveredAmount:delivered,retainedAmount:retained,destinationCustodyId:delivered==='0.00'?null:safe}))
    const receive=(id,amount)=>run(tx=>c.receiveTransfer(tx,receiver,id,{receivedAmount:amount}))
    await close(f.session.id);const original=await hand(f.session,'200.00','0.00');await receive(original.handover.transfer_id,'200.00')
    const b0=await open(f.register2,'40.00','2026-01-02');await close(b0.id);await hand(b0,'0.00','40.00')
    const a1=await open(f.register,'100.00'),b1=await open(f.register2,'40.00')
    await pay(a1,50);await pay(b1,25)
    await run(tx=>require('../src/modules/cash-closure/physicalMovements').createPhysicalMovement(tx,{...f.scope,canCreateOwn:true},{requestKey:randomUUID(),cashRegisterSessionId:a1.id,direction:'OUT',amount:'10.00',paymentMethodId:f.method.id,counterpartyLabel:'Resguardo externo',reason:'Retiro físico real'}))
    const transfer=await run(tx=>c.sendTransfer(tx,staff,{requestKey:randomUUID(),origin:{kind:'SESSION',sessionId:a1.id},destination:{kind:'REGISTER',registerId:f.register2.id},amount:'20.00',reason:'Traslado interno'}));await receive(transfer.transfer.id,'20.00')
    await close(a1.id);await hand(a1,'60.00','60.00')
    const incoming=await run(tx=>c.sendTransfer(tx,staff,{requestKey:randomUUID(),origin:{kind:'CUSTODY',custodyId:safe},destination:{kind:'REGISTER',registerId:f.register.id},amount:'15.00',reason:'Fondo desde custodia'}));await receive(incoming.transfer.id,'15.00')
    const a2=await open(f.register,'75.00');assert.equal(String(a2.opening_inherited_amount),'75.00')
    await pay(a2,30);await close(a2.id);await hand(a2,shortage?'104.00':'105.00','0.00')
    await countAndFinalize(db,f,a1.id);await countAndFinalize(db,f,a2.id,shortage);await countAndFinalize(db,f,b1.id)
    const api=require('../src/modules/cash-closure/dailyConsolidation'),scope={...f.scope,canView:true,canFinalize:true},view=await api.dayView(db,scope,day),bridge=view.snapshot.cash.bridge
    assert.deepEqual(view.snapshot.blockers,[])
    assert.equal(bridge.initial,'140.00');assert.equal(bridge.internal.inheritedWithinDay,'60.00');assert.equal(bridge.internal.openingTransfersIn,'15.00');assert.equal(bridge.final,'85.00');assert.equal(bridge.balanced,true)
    assert.equal(bridge.acceptedDifference,shortage?'-1.00':'0.00')
    const final=await run(tx=>api.finalizeDay(tx,scope,day,{contentKey:view.contentKey}));assert.deepEqual(final.view.snapshot.cash.bridge,bridge)
  })}finally{await db.$disconnect()}
})
