const test=require('node:test'),assert=require('node:assert/strict')
const {runRehearsal,cleanupRehearsal,allowedObjects}=require('../scripts/migrations/rehearsal')
test('rehearsal refuses without opt-in before opening any database',async()=>{
  let opened=0
  await assert.rejects(runRehearsal({env:{},open:()=>{opened++}}),{code:'BASELINE_OPT_IN_REQUIRED'})
  assert.equal(opened,0)
})
test('cleanup refuses shared, foreign and changed namespaces without emitting DDL',async()=>{
  const ddl=[],db={$queryRawUnsafe:async()=>[{oid:'42',name:'unexpected'}],$executeRawUnsafe:async sql=>ddl.push(sql)}
  await assert.rejects(cleanupRehearsal(db,{schema:'public',oid:'42',allowed:[]}),{code:'BASELINE_SCHEMA_INVALID'})
  await assert.rejects(cleanupRehearsal(db,{schema:'auna_baseline_qa_'+'a'.repeat(32),oid:'41',allowed:[]}),{code:'BASELINE_QA_CLEANUP_REFUSED'})
  await assert.rejects(cleanupRehearsal(db,{schema:'auna_baseline_qa_'+'a'.repeat(32),oid:'42',allowed:[]}),{code:'BASELINE_QA_CLEANUP_REFUSED'})
  assert.deepEqual(ddl,[])
})
test('timed-out children and their descendants are terminated before the caller resumes',async()=>{
  const {child}=require('../scripts/reconcile-migrations'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auna-child-test-')),file=path.join(dir,'late')
  try{
    const script=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(file)},'late'),500)`)}],{stdio:'inherit'});setTimeout(()=>{},10000)`
    await assert.rejects(child(process.execPath,['-e',script],process.env,{timeout:150}),/timeout/)
    await new Promise(resolve=>setTimeout(resolve,650))
    assert.equal(fs.existsSync(file),false)
  }finally{fs.rmSync(dir,{recursive:true})}
})
test('failed native commands preserve exit status and sanitized stdout for exact pending-migration diagnosis',async()=>{
  const {child}=require('../scripts/reconcile-migrations')
  await assert.rejects(child(process.execPath,['-e',"console.log('Pending 202610150002_company_payment_methods');process.exit(1)"]),error=>error.exitCode===1&&error.stdout.includes('Pending 202610150002_company_payment_methods'))
})
test('registered recovery metadata includes its PostgreSQL row-array types for exact cleanup',()=>{
  const names=allowedObjects({tables:[],sequences:[],indexes:[],functions:[],types:[]},'',['_prisma_migrations_original','_auna_attempt_abc'])
  assert.ok(names.includes('__prisma_migrations_original'))
  assert.ok(names.includes('__auna_attempt_abc'))
  assert.ok(!names.includes('unexpected'))
})
