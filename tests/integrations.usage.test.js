const test=require('node:test'),assert=require('node:assert/strict')
const {fixture,scope,input,COMPANY}=require('./helpers/integrationsDb')
const now=new Date('2026-10-26T12:00:00Z')
test('usage groups counts safely without exposing events and preserves half open UTC bounds',async()=>{
 const {getUsageSummary}=require('../src/modules/integrations/usage'),f=fixture()
 f.db.$queryRaw=async query=>{
  assert.ok(query.values.includes(COMPANY));assert.ok(query.values.some(v=>v instanceof Date&&v.toISOString()==='2026-10-19T12:00:00.000Z'))
  assert.ok(query.values.some(v=>v instanceof Date&&v.toISOString()===now.toISOString()))
  return[{route:'/quotes',family:'2xx',count:3n},{route:'/quotes',family:'4xx',count:1n},{route:'/branches',family:'5xx',count:1n}]
 }
 const out=await getUsageSummary(f.db,scope,{period:'7d'},now)
 assert.equal(out.total,5);assert.equal(out.successful,3);assert.equal(out.errors,2);assert.equal(out.errorRate,0.4)
 assert.deepEqual(out.byRoute,[{route:'/quotes',count:4},{route:'/branches',count:1}]);assert.equal(out.retentionDays,30)
 assert.equal(out.coverage,'AUTHENTICATED_RECORDED');assert.doesNotMatch(JSON.stringify(out),/metadata|credential_id|secret|customer/)
})
test('usage requires view and own credential; malformed queries and unsafe counts fail closed',async()=>{
 const {getUsageSummary}=require('../src/modules/integrations/usage'),f=fixture()
 f.db.$queryRaw=async()=>[]
 const out=await getUsageSummary(f.db,scope,{period:'24h'},now)
 assert.equal(out.total,0);assert.equal(out.errorRate,null);assert.deepEqual(out.byRoute,[])
 await assert.rejects(()=>getUsageSummary(f.db,{...scope,isAdmin:false,permissions:[]},{period:'7d'},now),{status:403})
 for(const query of [{period:'all'},{period:['7d']},{period:'7d',companyId:COMPANY}])await assert.rejects(()=>getUsageSummary(f.db,scope,query,now),{status:400})
 await assert.rejects(()=>getUsageSummary(f.db,scope,{period:'30d',credentialId:COMPANY},now),{status:404})
 f.db.$queryRaw=async()=>[{route:'/quotes',family:'2xx',count:9007199254740992n}]
 await assert.rejects(()=>getUsageSummary(f.db,scope,{period:'7d'},now),{integrationCode:'UNAVAILABLE'})
})
test('new draft creation has one auditable HTTP result and metadata never enters its route',async()=>{
 const f=fixture(),key=await require('../src/modules/integrations/management').createCredential(f.db,scope,input,now)
 await require('../src/modules/integrations/audit').recordDraftCreation(f.db,{companyId:COMPANY,credentialId:key.credential.id},{documentId:COMPANY,type:'QUOTE',branchId:scope.branchId,requestId:null},now)
 const events=f.events.filter(e=>e.action==='CREATE_DRAFT')
 assert.equal(events.length,1);assert.equal(events[0].status,201);assert.equal(events[0].route,'/quotes')
 assert.equal(f.events.filter(e=>e.action==='USE').length,0)
})
