const test=require('node:test'),assert=require('node:assert/strict'),{fixture,scope,input,COMPANY}=require('./helpers/integrationsDb')
test('a key lifecycle cannot widen its data grant and current permission loss immediately stops delivery',async()=>{
 const f=fixture(),m=require('../src/modules/integrations/management'),{authenticateIntegration}=require('../src/modules/integrations/auth'),key=await m.createCredential(f.db,scope,input)
 assert.deepEqual((await authenticateIntegration(f.db,'Bearer '+key.apiKey)).scopes,['products.read'])
 await assert.rejects(()=>m.replaceCredential(f.db,scope,key.credential.id,{...input,scopes:['products.read','prices.read']}),{status:403})
 const authorizedMembership=f.db.userCompany.findUnique
 f.db.userCompany.findUnique=async()=>({status:'ACTIVE',company:{active:true},role:{name:'Custom',company_id:COMPANY,permissions:[]},user:{name:'Ana'}})
 await assert.rejects(()=>authenticateIntegration(f.db,'Bearer '+key.apiKey),{status:403})
 assert.equal(f.rows.length,1)
 await assert.rejects(()=>m.revokeCredential(f.db,scope,key.credential.id),{status:403})
 f.db.userCompany.findUnique=authorizedMembership
 await m.revokeCredential(f.db,scope,key.credential.id)
 assert.equal((await m.getCredential(f.db,scope,key.credential.id)).status,'REVOKED')
 assert.equal(f.events.filter(e=>e.action==='REVOKE').length,1)
})
