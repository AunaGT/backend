const test=require('node:test'),assert=require('node:assert/strict'),{fixture,scope,input}=require('./helpers/integrationsDb')
test('API keys are exclusive credentials and revocation or membership changes affect the next request',async()=>{
 const {authenticateIntegration}=require('../src/modules/integrations/auth'),f=fixture(),now=new Date(),{createCredential,revokeCredential}=require('../src/modules/integrations/management'),key=await createCredential(f.db,scope,input,now)
 const context=await authenticateIntegration(f.db,'Bearer '+key.apiKey,now);assert.deepEqual(context.scopes,['products.read'])
 for(const raw of [undefined,'Bearer session.jwt.token','Basic '+key.apiKey,key.apiKey])await assert.rejects(()=>authenticateIntegration(f.db,raw,now),{status:401})
 await revokeCredential(f.db,scope,key.credential.id,now);await assert.rejects(()=>authenticateIntegration(f.db,'Bearer '+key.apiKey,now),{status:401})
})
test('no credential can impersonate another tenant or branch through headers',()=>{
 const {validateContextHeaders}=require('../src/modules/integrations/auth'),context={companyId:'a',branches:[{id:'b'}]}
 for(const req of [{headers:{'x-company-id':'other'},query:{}},{headers:{'x-branch-id':'other'},query:{}},{headers:{},query:{companyId:'other'}}])assert.throws(()=>validateContextHeaders(req,context),{status:403})
 validateContextHeaders({headers:{},query:{branchId:'b'}},context)
})
