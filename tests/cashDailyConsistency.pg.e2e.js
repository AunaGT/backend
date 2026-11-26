const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDailyQa.cjs'),{countAndFinalize}=require('./helpers/cashDailyScenario.cjs')
const url=process.env.AUNA_CASH_DAILY_QA_URL,defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
test('a busy handover cannot be omitted from an immutable daily snapshot',{skip:!url,timeout:120000},async()=>{
  const qa=await qaSchema(url),{db}=qa
  try{
    const f=await fixture(db),api=require('../src/modules/cash-closure/dailyConsolidation'),c=require('../src/modules/cash-closure/custody'),scope={...f.scope,canView:true,canFinalize:true,canOperateOwn:true}
    await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'DISABLED'}})
    await countAndFinalize(db,f,f.session.id)
    const before=await api.dayView(db,scope,'2026-10-28'),ready=defer(),release=defer(),run=fn=>db.$transaction(fn,{timeout:20000})
    const handover=run(async tx=>{await c.handoverTurn(tx,scope,f.session.id,{requestKey:randomUUID(),deliveredAmount:'0.00',retainedAmount:'200.00',destinationCustodyId:null});ready.resolve();await release.promise})
    await ready.promise
    try{await assert.rejects(run(tx=>api.finalizeDay(tx,scope,'2026-10-28',{contentKey:before.contentKey})),e=>e.code==='CASH_DAY_BUSY')}finally{release.resolve()}
    await handover
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_daily_consolidations WHERE branch_id=${f.branch.id}::uuid`)[0].n,0)
    await assert.rejects(run(tx=>api.finalizeDay(tx,scope,'2026-10-28',{contentKey:before.contentKey})),e=>e.code==='CASH_DAY_CHANGED')
    const updated=await api.dayView(db,scope,'2026-10-28'),done=await run(tx=>api.finalizeDay(tx,scope,'2026-10-28',{contentKey:updated.contentKey}))
    assert.equal(done.view.snapshot.cash.bridge.retainedFinal,'200.00');assert.equal(done.view.snapshot.cash.bridge.undeliveredFinal,'0.00')
  }finally{await db.$disconnect()}
})
test('retained-fund transfers and physical returns preserve the source lineage and one ending balance',{skip:!url,timeout:120000},async t=>{
  const qa=await qaSchema(url),{db}=qa
  try{for(const destination of ['REGISTER','CUSTODY','RETURN'])await t.test(destination,async()=>{
    const f=await fixture(db),c=require('../src/modules/cash-closure/custody'),api=require('../src/modules/cash-closure/dailyConsolidation'),scope={...f.scope,canView:true,canFinalize:true,canOperateOwn:true,canOperateTeam:true,canReceive:true},receiver={...scope,userId:f.other.id},run=fn=>db.$transaction(fn,{timeout:20000}),date='2026-10-29'
    await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:'DISABLED'}})
    const open=(r,amount)=>run(async tx=>require('../src/services/cashEventAdoption').openEventSession(tx,scope,await require('../src/services/cashSessionBoundary').lockScopedRegister(tx,scope,r.id),{openingFloat:amount,notes:null,now:new Date(date+'T12:00:00Z')}))
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
    const a=await open(f.register,'100.00');await countAndFinalize(db,f,a.id)
    await run(tx=>c.handoverTurn(tx,scope,a.id,{requestKey:randomUUID(),deliveredAmount:'0.00',retainedAmount:'100.00',destinationCustodyId:null}))
    const safe=destination==='CUSTODY'?await require('./helpers/cashCustodyQa.cjs').custody(db,f):null
    const command={requestKey:randomUUID(),origin:{kind:'FLOAT',registerId:f.register.id},destination:safe?{kind:'CUSTODY',custodyId:safe}:{kind:'REGISTER',registerId:f.register2.id},amount:'100.00',reason:'Traslado de fondo retenido'}
    let transfer
    if(destination==='CUSTODY'){
      const reviewed=await api.dayView(db,scope,date),ready=defer(),release=defer()
      const sending=run(async tx=>{const result=await c.sendTransfer(tx,scope,command);ready.resolve();await release.promise;return result})
      await ready.promise
      try{await assert.rejects(run(tx=>api.finalizeDay(tx,scope,date,{contentKey:reviewed.contentKey})),e=>e.code==='CASH_DAY_BUSY')}finally{release.resolve()}
      transfer=(await sending).transfer
    }else transfer=(await run(tx=>c.sendTransfer(tx,scope,command))).transfer
    if(destination==='RETURN'){
      const rejected=await run(tx=>c.rejectTransfer(tx,receiver,transfer.id,{reason:'No se recibe en esta caja'}))
      await run(tx=>c.receiveTransfer(tx,scope,rejected.transfer.return_transfer_id,{receivedAmount:'100.00'}))
    }else{
      await run(tx=>c.receiveTransfer(tx,receiver,transfer.id,{receivedAmount:'100.00'}))
      if(destination==='REGISTER'){const b=await open(f.register2,'100.00');await countAndFinalize(db,f,b.id)}
    }
    const view=await api.dayView(db,scope,date),bridge=view.snapshot.cash.bridge
    assert.equal(bridge.final,destination==='CUSTODY'?'0.00':'100.00');assert.equal(bridge.balanced,true)
    assert.equal(bridge.retainedFinal,destination==='RETURN'?'100.00':'0.00')
    assert.equal(bridge.internal.net,destination==='CUSTODY'?'-100.00':'0.00')
    assert.equal(bridge.internal.floatTransfersOut,'100.00')
    await run(tx=>api.finalizeDay(tx,scope,date,{contentKey:view.contentKey}))
  })}finally{await db.$disconnect()}
})
