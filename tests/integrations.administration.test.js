const test=require('node:test'),assert=require('node:assert/strict')
const now=new Date('2026-10-26T12:00:00Z')
const {fixture,scope,input,OWNER,BRANCH}=require('./helpers/integrationsDb')
const m=require('../src/modules/integrations/management')
test('credential state prioritizes revocation and expiry over pause',()=>{
 const {credentialState}=require('../src/modules/integrations/credentialState')
 const row={expires_at:null,revoked_at:null,paused_at:null}
 assert.equal(credentialState(row,now),'ACTIVE')
 assert.equal(credentialState({...row,paused_at:now},now),'PAUSED')
 assert.equal(credentialState({...row,expires_at:now,paused_at:now},now),'EXPIRED')
 assert.equal(credentialState({...row,expires_at:now,revoked_at:now,paused_at:now},now),'REVOKED')
})
test('pause blocks authentication and prepared drafts; repeated state changes audit once',async()=>{
 const f=fixture(),key=await m.createCredential(f.db,scope,{...input,scopes:['quotes.create_draft'],days:null},now)
 const {authenticateIntegration}=require('../src/modules/integrations/auth'),{revalidateDraftContext}=require('../src/modules/integrations/policy')
 const ctx=await authenticateIntegration(f.db,'Bearer '+key.apiKey,now)
 assert.equal((await m.pauseCredential(f.db,scope,key.credential.id,now)).status,'PAUSED')
 await m.pauseCredential(f.db,scope,key.credential.id,now)
 assert.equal(f.events.filter(e=>e.action==='PAUSE').length,1)
 await assert.rejects(()=>authenticateIntegration(f.db,'Bearer '+key.apiKey,now),{status:401})
 await assert.rejects(()=>revalidateDraftContext(f.db,ctx,'QUOTE',BRANCH,now,{lockCredential:true}),{status:401})
 assert.equal((await m.resumeCredential(f.db,scope,key.credential.id,now)).status,'ACTIVE')
 await m.resumeCredential(f.db,scope,key.credential.id,now)
 assert.equal(f.events.filter(e=>e.action==='RESUME').length,1)
 assert.equal((await authenticateIntegration(f.db,'Bearer '+key.apiKey,now)).credentialId,key.credential.id)
})
test('a paused replacement stays paused and does not revoke the original',async()=>{
 const f=fixture(),key=await m.createCredential(f.db,scope,input,now)
 await m.pauseCredential(f.db,scope,key.credential.id,now)
 const next=await m.replaceCredential(f.db,scope,key.credential.id,input,now)
 assert.equal(next.credential.status,'PAUSED');assert.equal(next.credential.integrationId,key.credential.integrationId)
 assert.equal(f.rows[0].revoked_at,null);assert.ok(next.credential.pausedAt)
})
test('paused keys consume the twenty key ceiling',async()=>{
 const f=fixture()
 for(let i=0;i<20;i++){const key=await m.createCredential(f.db,scope,{...input,days:null},now);await m.pauseCredential(f.db,scope,key.credential.id,now)}
 await assert.rejects(()=>m.createCredential(f.db,scope,input,now),{integrationCode:'KEY_LIMIT'})
})
test('resume cannot restore expired or revoked credentials or lost owner grants',async()=>{
 const f=fixture(),key=await m.createCredential(f.db,scope,input,now)
 await m.pauseCredential(f.db,scope,key.credential.id,now)
 await assert.rejects(()=>m.resumeCredential(f.db,scope,key.credential.id,new Date('2027-10-26')),{status:409})
 const original=f.db.userCompany.findUnique
 f.db.userCompany.findUnique=async()=>({status:'ACTIVE',company:{active:true},user:{name:'Ana'},role:{name:'Reader',company_id:scope.companyId,permissions:[{permission:{code:'integrations.manage'}}]}})
 await assert.rejects(()=>m.resumeCredential(f.db,scope,key.credential.id,now),{status:403})
 f.db.userCompany.findUnique=original
 await m.revokeCredential(f.db,scope,key.credential.id,now)
 await assert.rejects(()=>m.resumeCredential(f.db,scope,key.credential.id,now),{status:409})
 await assert.rejects(()=>m.pauseCredential(f.db,scope,key.credential.id,now),{status:409})
})
test('fresh manager authority and branch assignment are checked despite stale session claims',async()=>{
 const f=fixture(),key=await m.createCredential(f.db,scope,input,now)
 f.db.userCompany.findUnique=async()=>({status:'ACTIVE',company:{active:true},user:{name:'Ana'},role:{name:'Reader',company_id:scope.companyId,permissions:[{permission:{code:'products.view'}}]}})
 for(const fn of [m.pauseCredential,m.resumeCredential,m.revokeCredential])await assert.rejects(()=>fn(f.db,scope,key.credential.id,now),{status:403})
 assert.equal(f.rows[0].paused_at??null,null);assert.equal(f.rows[0].revoked_at,null)
})
test('failed state audit rolls back the metadata and cross tenant ids never resolve',async()=>{
 const f=fixture(),key=await m.createCredential(f.db,scope,input,now)
 await assert.rejects(()=>m.pauseCredential(f.db,{...scope,companyId:OWNER},key.credential.id,now),{status:404})
 f.breakAudit();await assert.rejects(()=>m.pauseCredential(f.db,scope,key.credential.id,now))
 assert.equal(f.rows[0].paused_at??null,null)
 assert.equal(f.events.length,1)
})
test('only explicit null expiry remains available while malformed expiry fails closed',()=>{
 const {credentialUnavailable}=require('../src/modules/integrations/credentialState')
 assert.equal(credentialUnavailable({expires_at:null},now),false)
 for(const expires_at of [undefined,'invalid',new Date(NaN),now])assert.equal(credentialUnavailable({expires_at},now),true)
 assert.equal(credentialUnavailable({expires_at:null,paused_at:now},now),true)
 assert.equal(credentialUnavailable(null,now),true)
})
test('credential filters combine state scope and tenant with stable pagination',async()=>{
 const f=fixture()
 for(const name of ['Web Norte','Web Sur','Otra'])await m.createCredential(f.db,scope,{...input,name,days:null},now)
 await m.pauseCredential(f.db,scope,f.rows[1].id,now)
 f.rows.push({...f.rows[0],id:OWNER,company_id:OWNER,name:'Web ajena'})
 const result=await m.listCredentials(f.db,scope,{q:'Web',status:'PAUSED',scope:'products.read'},now)
 assert.equal(result.total,1);assert.equal(result.items[0].name,'Web Sur')
 assert.equal((await m.listCredentials(f.db,scope,{q:f.rows[0].public_id.slice(0,10)},now)).items[0].id,f.rows[0].id)
 const page=await m.listCredentials(f.db,scope,{page:'2',pageSize:'1'},now)
 assert.equal(page.total,3);assert.equal(page.items.length,1)
 assert.equal((await m.listCredentials(f.db,scope,{status:'ACTIVE'},now)).total,2)
 f.rows[1].expires_at=now
 assert.equal((await m.listCredentials(f.db,scope,{status:'PAUSED'},now)).total,0)
 assert.equal((await m.listCredentials(f.db,scope,{status:'EXPIRED'},now)).total,1)
 f.rows[1].revoked_at=now
 assert.equal((await m.listCredentials(f.db,scope,{status:'REVOKED'},now)).total,1)
})
test('unknown query inputs and pasted secrets fail without echo',async()=>{
 const f=fixture(),key=await m.createCredential(f.db,scope,input,now)
 for(const query of [{companyId:OWNER},{q:key.apiKey},{q:'Authorization: Bearer '+key.apiKey},{q:'x'.repeat(101)},{q:['Web']},{status:'oops'},{scope:'customers.admin'},{page:['1']},{pageSize:{value:20}}]){
  await assert.rejects(()=>m.listCredentials(f.db,scope,query,now),e=>e.status===400&&!e.message.includes(key.apiKey))
 }
})
