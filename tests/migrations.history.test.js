const test=require('node:test'),assert=require('node:assert/strict')
const {historyFixture}=require('./helpers/migrationHistoryFixture.cjs')
const {inspectHistory,archiveHistory,recoverHistory,withMigrationGate,applyPaymentCommands,validateRehearsal,assertNoWriters}=require('../scripts/migrations/history')
test('remote history determines resumption after lost archive or resolve confirmation',async()=>{
  for(const phase of ['CAPTURED','ARCHIVED','BASELINED','PAYMENTS_APPLIED']){
    const db=historyFixture(phase)
    assert.equal(await inspectHistory(db,db.receipt),phase)
    if(phase!=='CAPTURED'){await archiveHistory(db,db.receipt);assert.deepEqual(db.ddl,[])}
  }
})
test('changed original OID or checksum and unknown new history are not accepted',async()=>{
  for(const change of ['oid','checksum','unknown']){
    const db=historyFixture('BASELINED')
    if(change==='oid')db.tables.get('auna_migration_audit._prisma_migrations_20261015').oid='99'
    if(change==='checksum')db.tables.get('auna_migration_audit._prisma_migrations_20261015').rows[0].checksum='changed'
    if(change==='unknown')db.tables.get('public._prisma_migrations').rows[0].migration_name='another'
    await assert.rejects(inspectHistory(db,db.receipt),{code:'BASELINE_HISTORY_REVIEW_REQUIRED'})
    assert.deepEqual(db.ddl,[])
  }
})
test('recovery never changes metadata after payments committed',async()=>{
  const db=historyFixture('PAYMENTS_APPLIED')
  await assert.rejects(recoverHistory(db,db.receipt),{code:'BASELINE_RECOVERY_REVIEW_REQUIRED'})
  assert.deepEqual(db.ddl,[])
})
test('partial, changed or unclean rehearsals cannot authorize history promotion',()=>{
  const r={sourceReceiptHash:'source',baselineChecksum:'baseline',paymentChecksum:'payment',installation:true,historyRecovery:true,qaCleaned:true}
  for(const changed of [{installation:false},{historyRecovery:false},{qaCleaned:false},{sourceReceiptHash:'other'},{paymentChecksum:'other'}])
    assert.throws(()=>validateRehearsal({...r,...changed},{sourceReceiptHash:'source',baselineChecksum:'baseline',paymentChecksum:'payment'}),{code:'BASELINE_REHEARSAL_REQUIRED'})
})
test('deploy failure prevents generate and status; wrong phase starts no child',async()=>{
  for(const phase of ['CAPTURED','BASELINED']){
    const db=historyFixture(phase),calls=[]
    await assert.rejects(applyPaymentCommands(db,db.receipt,{check:async()=>{},signal:new AbortController().signal},async args=>{calls.push(args);throw Error('deploy failure')}))
    assert.equal(calls.length,phase==='BASELINED'?1:0)
    if(calls.length)assert.deepEqual(calls[0],['migrate','deploy'])
  }
})
test('transaction-bound gate aborts work on lost heartbeat and releases on exit',async()=>{
  let calls=0,released=false
  const db={$transaction:async(work,options)=>{assert.equal(options.timeout,300000);try{return await work({$queryRawUnsafe:async sql=>{if(sql.includes('pg_try_advisory'))return [{acquired:true}];if(++calls>1)throw Error('connection lost');return [{alive:1}]}})}finally{released=true}}}
  await assert.rejects(withMigrationGate(db,async gate=>{await gate.check();await gate.check();throw Error('must not reach')}),{code:'BASELINE_GUARD_LOST'})
  assert.equal(released,true)
})
test('uncoordinated peer sessions are refused even when their query starts with SELECT',async()=>{
  await assert.rejects(assertNoWriters({$queryRawUnsafe:async()=>[{pid:99,query:'SELECT mutating_function()',state:'active'}]},42),{code:'BASELINE_WRITER_DETECTED'})
})
test('promotion refuses missing opt-in and unknown modes before reading files or opening connections',async()=>{
  const {runPromotion}=require('../scripts/migrations/promotion')
  await assert.rejects(runPromotion({mode:'promote-history',env:{}}),{code:'BASELINE_OPT_IN_REQUIRED'})
  await assert.rejects(runPromotion({mode:'unknown',env:{AUNA_BASELINE_DEV:'1'}}),{code:'BASELINE_MODE_INVALID'})
})
