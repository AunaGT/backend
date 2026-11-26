const test = require('node:test')
const assert = require('node:assert/strict')
const { canonicalHash } = require('../src/modules/cash-closure/disputes.domain')
const { beginDisputeCommand, finishDisputeCommand, lockDisputeResources } = require('../src/modules/cash-closure/disputes.boundary')
const ids = ['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004']
const scope = {companyId:ids[0],branchId:ids[1],branchIds:[ids[1]],userId:ids[2]}
const key = ids[3]
function commandDb(old) {
  return {$queryRaw:async (strings,...values) => {
    const sql={strings,values}
    if (sql.strings.join('').includes('pg_advisory_xact_lock')) return [{}]
    if (sql.strings.join('').includes('FROM cash_dispute_commands')) return old ? [old] : []
    throw Error('Unexpected command query')
  }}
}
test('same committed attempt returns its exact result but different payload is a conflict', async () => {
  const payload={amount:'10.00',eventId:ids[3]},result={id:ids[3],status:'OPEN'}
  const db=commandDb({content_hash:canonicalHash(payload),result})
  assert.deepEqual(await beginDisputeCommand(db,scope,'CREATE',{requestKey:key},payload),{replayed:true,result})
  await assert.rejects(beginDisputeCommand(db,scope,'CREATE',{requestKey:key},{...payload,amount:'11.00'}),{code:'DISPUTE_ATTEMPT_CONFLICT',status:409})
})
test('commands require concrete scope and UUID before any transaction query',async()=>{
  const noDb={$queryRaw:()=>assert.fail('Invalid scope reached storage')}
  await assert.rejects(beginDisputeCommand(noDb,{...scope,branchId:'all'},'CREATE',{requestKey:key},{}),{status:403})
  await assert.rejects(beginDisputeCommand(noDb,scope,'CREATE',{requestKey:'bad'},{}),{status:400})
})
test('a finished attempt stores and returns one canonical result without rewriting a previous receipt',async()=>{
  const attempt=await beginDisputeCommand(commandDb(),scope,'CREATE',{requestKey:key},{amount:'10.00'})
  let saved
  const db={$executeRaw:async (strings,...values)=>{saved={strings,values};return 1}}
  const result={id:ids[3],status:'OPEN'}
  assert.deepEqual(await finishDisputeCommand(db,attempt,result),result)
  assert.ok(saved.strings.join('').includes('INSERT INTO cash_dispute_commands'))
  assert.ok(!saved.strings.join('').includes('UPDATE'))
  assert.ok(saved.values.includes(JSON.stringify(result)))
})
test('shared resource locks sort and deduplicate clients before origins',async()=>{
  const acquired=[]
  const db={$executeRaw:async (strings,...values)=>{acquired.push([values.at(-1)]);return 1},$queryRaw:async (strings,...values)=>{acquired.push(values);return [{}]}}
  await lockDisputeResources(db,scope,{customerIds:[ids[3],ids[2],ids[3]],eventIds:[ids[1],ids[0],ids[1]]})
  assert.deepEqual(acquired.map(values=>values[0]),[ids[2],ids[3],JSON.stringify(['cash-dispute-origin',ids[0],ids[0]]),JSON.stringify(['cash-dispute-origin',ids[0],ids[1]])])
})
test('UUID case cannot split locks or attempts for the same database identities',async()=>{
  const lower={companyId:'abcdefab-0000-4000-8000-000000000001',branchId:'abcdefab-0000-4000-8000-000000000002',userId:'abcdefab-0000-4000-8000-000000000003'}
  const upper=Object.fromEntries(Object.entries(lower).map(([k,v])=>[k,v.toUpperCase()]))
  const locks=[]
  const db={$executeRaw:async()=>1,$queryRaw:async(strings,...values)=>{if(strings.join('').includes('pg_advisory_xact_lock'))locks.push(values[0]);return []}}
  const a=await beginDisputeCommand(db,lower,'CREATE',{requestKey:key},{})
  const b=await beginDisputeCommand(db,upper,'CREATE',{requestKey:key.toUpperCase()},{})
  assert.deepEqual(b,a)
  await lockDisputeResources(db,lower,{customerIds:[],eventIds:[key]})
  await lockDisputeResources(db,upper,{customerIds:[],eventIds:[key.toUpperCase()]})
  assert.equal(locks[0],locks[1]);assert.equal(locks[2],locks[3])
})
