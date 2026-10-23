const test=require('node:test'),assert=require('node:assert/strict')
const {rollbackCheckout}=require('../scripts/diagnose-pos-checkout')
test('diagnostic requires rollback opt-in and only allows bounded 1, 3 or 10 line samples',()=>{
 const {parseDiagnosticArgs}=require('../scripts/diagnose-pos-checkout');assert.equal(typeof parseDiagnosticArgs,'function')
 assert.equal(parseDiagnosticArgs(['--rollback']),1)
 for(const n of [1,3,10])assert.equal(parseDiagnosticArgs(['--rollback',`--lines=${n}`]),n)
 for(const args of [[],['--lines=3'],['--rollback','--lines=100'],['--rollback','--lines=3','extra'],['--rollback','--lines=03']])assert.throws(()=>parseDiagnosticArgs(args))
})
test('checkout diagnostic always rolls back successful controller work instead of committing it',async()=>{
 let committed=false,rolledBack=false
 const tx={$executeRawUnsafe:async sql=>assert.equal(sql,"SET LOCAL lock_timeout = '1500ms'")}
 const db={$transaction:async run=>{try{const value=await run(tx);committed=true;return value}catch(error){rolledBack=true;throw error}}}
 assert.equal(await rollbackCheckout(db,async client=>{assert.equal(client,tx);return 'measured'}),'measured')
 assert.equal(committed,false);assert.equal(rolledBack,true)
})
test('checkout diagnostic propagates controller failure after rollback without returning partial success',async()=>{
 const failure=Error('failed'),db={$transaction:run=>run({$executeRawUnsafe:async()=>{}})}
 await assert.rejects(rollbackCheckout(db,async()=>{throw failure}),error=>error===failure)
})
test('diagnostic suppresses sensitive service errors and restores the logger even after failure',async()=>{
 const {quietDiagnostic}=require('../scripts/diagnose-pos-checkout')
 const printed=[],logger=Object.fromEntries(['log','info','warn','error'].map(key=>[key,(...values)=>printed.push(values)])),original={...logger}
 const secret='PRIVATE_PRODUCT_ID secret=do-not-print',failure=Error('failed')
 await assert.rejects(quietDiagnostic(async()=>{logger.error(secret);logger.warn(secret);throw failure},logger),error=>error===failure)
 assert.deepEqual(printed,[])
 for(const key of Object.keys(original))assert.equal(logger[key],original[key])
 const result=await quietDiagnostic(async()=>{logger.error(secret);return 'measured'},logger)
 assert.deepEqual(result,{value:'measured',suppressedMessages:1});assert.deepEqual(printed,[])
})
