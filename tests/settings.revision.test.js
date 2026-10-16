const test=require('node:test'),assert=require('node:assert/strict')
const service=()=>require('../src/services/settingsRevision')
test('revisions preserve absence and prototype-looking setting keys without inheritance',()=>{
  const {settingRevisions}=service()
  assert.deepEqual(settingRevisions([{key:'company_name',revision:4}],['company_name','timezone','constructor']),{company_name:4,timezone:0,constructor:0})
})
test('expected revisions reject missing or coercible versions before database work',()=>{
  const {assertExpectedRevisions}=service(),changes={company_name:{value:'QA',type:'string'}}
  assert.throws(()=>assertExpectedRevisions(changes,undefined),e=>e.status===428)
  for(const expected of [{},{company_name:'1'},{company_name:-1},{company_name:1.2},[]]) assert.throws(()=>assertExpectedRevisions(changes,expected),e=>e.status===400)
  assert.doesNotThrow(()=>assertExpectedRevisions(changes,{company_name:0}))
})
test('CAS compares company and revision; a stale write never falls back to upsert',async()=>{
  const {writeSettings}=service(),calls=[]
  const tx={systemSetting:{updateMany:async args=>{calls.push(args);return{count:0}},findMany:async()=>{throw Error('No leer éxito de conflicto')}}}
  await assert.rejects(writeSettings(tx,{companyId:'A',changes:{company_name:{value:'Nuevo',type:'string'}},expectedRevisions:{company_name:3}}),e=>e.status===409)
  assert.deepEqual(calls[0].where,{company_id:'A',key:'company_name',revision:3})
})
test('an absent-key race is a conflict and a successful write returns the real stored revisions',async()=>{
  const {writeSettings}=service(),changes={company_name:{value:'QA',type:'string'}}
  await assert.rejects(writeSettings({systemSetting:{create:async()=>{throw Object.assign(Error('duplicate'),{code:'P2002'})}}},{companyId:'A',changes,expectedRevisions:{company_name:0}}),e=>e.status===409)
  const calls=[],row={company_id:'A',key:'company_name',revision:2,value:'QA',type:'string'}
  const tx={systemSetting:{updateMany:async args=>{calls.push(args);return{count:1}},findMany:async args=>{assert.equal(args.where.company_id,'A');return[row]}}}
  assert.deepEqual(await writeSettings(tx,{companyId:'A',changes,expectedRevisions:{company_name:1}}),[row])
  assert.deepEqual(calls[0].data,{value:'QA',type:'string'})
})
test('actor context is transaction-local and never leaks into a pooled later request',async()=>{
  const {setSettingsActor}=service(),calls=[]
  await setSettingsActor({$queryRaw:async(parts,...values)=>{calls.push([parts.join('?'),values])}},{actorId:'actor-id',source:'config'})
  assert.match(calls[0][0],/set_config/);assert.match(calls[0][0],/true/)
  assert.deepEqual(calls[0][1],['actor-id','config'])
})
