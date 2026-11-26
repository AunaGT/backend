const test=require('node:test'),assert=require('node:assert/strict')
const {fixture,scope,input,COMPANY,BRANCH}=require('./helpers/integrationsDb')
const {parseCreateInput}=require('../src/modules/integrations/credentials')
const {effectiveScopes,loadIntegrationPrincipal,revalidateDraftContext}=require('../src/modules/integrations/policy')
const {createCredential,replaceCredential}=require('../src/modules/integrations/management')
const now=new Date('2026-10-25T12:00:00Z')
const draft={...input,scopes:['quotes.create_draft','customers.create'],customerPolicy:'CREATE_IF_MISSING',customerPaymentTermId:1}
function terms(f){f.db.paymentTerm={findFirst:async({where})=>where.company_id===COMPANY&&where.id===1&&where.deleted===false?{id:1,name:'Contado'}:null};return f}
test('old create requests stay restrictive and nine explicit scopes are accepted',()=>{
 const old=parseCreateInput(input);assert.equal(old.customerPolicy,'EXISTING_ONLY');assert.equal(old.customerPaymentTermId,null)
 const all=['products.read','categories.read','prices.read','availability.read','quotes.read','quotes.create_draft','orders.read','orders.create_draft','customers.create']
 assert.deepEqual(parseCreateInput({...draft,scopes:all}).scopes,all)
})
test('customer creation requires policy, scope, a draft scope and a positive term id together',()=>{
 for(const change of [{customerPaymentTermId:null},{customerPaymentTermId:0},{customerPaymentTermId:'1'},{scopes:['quotes.create_draft']},{scopes:['customers.create']},{customerPolicy:'EXISTING_ONLY'},{customerPolicy:'anything'}])assert.throws(()=>parseCreateInput({...draft,...change}),{status:400})
 assert.throws(()=>parseCreateInput({...input,customerPaymentTermId:1}),{status:400})
})
test('commercial module suspension does not disable independent catalog scopes',async()=>{
 const f=fixture();f.db.companyModule.findMany=async()=>[{module_code:'quotes',status:'SUSPENDED'}]
 const p=await loadIntegrationPrincipal(f.db,{companyId:COMPANY,ownerId:input.ownerId},now)
 assert.deepEqual(effectiveScopes(p,['products.read','quotes.create_draft','orders.read']),['products.read','orders.read'])
 assert.deepEqual(effectiveScopes({...p,isAdmin:false,permissions:['quotes.create']},['quotes.create_draft']),[])
})
test('create validates the tenant term, while replacement preserves identity and cannot widen customer policy',async()=>{
 const f=terms(fixture());await assert.rejects(()=>createCredential(f.db,scope,{...draft,customerPaymentTermId:2},now),{status:403})
 const a=await createCredential(f.db,scope,draft,now),b=await replaceCredential(f.db,scope,a.credential.id,draft,now)
 assert.equal(a.credential.integrationId,b.credential.integrationId);assert.ok(a.credential.integrationId)
 assert.equal(b.credential.customerPolicy,'CREATE_IF_MISSING');assert.equal(b.credential.customerPaymentTermId,1)
 await assert.rejects(()=>replaceCredential(f.db,scope,a.credential.id,{...draft,customerPaymentTermId:2},now),{status:403})
 const reduced=await replaceCredential(f.db,scope,a.credential.id,{...input,scopes:['quotes.create_draft']},now)
 assert.equal(reduced.credential.integrationId,a.credential.integrationId);assert.equal(reduced.credential.customerPolicy,'EXISTING_ONLY')
 await assert.rejects(()=>replaceCredential(f.db,scope,reduced.credential.id,draft,now),{status:403})
 const independent=await createCredential(f.db,scope,draft,now);assert.notEqual(independent.credential.integrationId,a.credential.integrationId)
})
test('draft authorization rechecks persisted grant, branch, identity, expiry and current role',async()=>{
 const f=terms(fixture()),a=await createCredential(f.db,scope,draft,now)
 const ctx={credentialId:a.credential.id,companyId:COMPANY,integrationId:a.credential.integrationId}
 const fresh=await revalidateDraftContext(f.db,ctx,'QUOTE',BRANCH,now);assert.equal(fresh.customerPaymentTermId,1)
 await assert.rejects(()=>revalidateDraftContext(f.db,{...ctx,integrationId:'other'},'QUOTE',BRANCH,now),{status:403})
 await assert.rejects(()=>revalidateDraftContext(f.db,ctx,'ORDER',BRANCH,now),{status:403})
 await assert.rejects(()=>revalidateDraftContext(f.db,ctx,'QUOTE','other',now),{status:403})
 f.rows[0].revoked_at=now
 await assert.rejects(()=>revalidateDraftContext(f.db,ctx,'QUOTE',BRANCH,now),{status:401})
})
test('management payment term lookup is scoped, bounded, and requires customer capability',async()=>{
 const f=fixture();f.db.paymentTerm={findMany:async({where,take})=>{assert.deepEqual(where,{company_id:COMPANY,deleted:false,name:{contains:'Cash',mode:'insensitive'}});assert.equal(take,26);return[{id:1,name:'Cash'}]}}
 const {getCustomerPaymentTerms}=require('../src/modules/integrations/management')
 assert.deepEqual(await getCustomerPaymentTerms(f.db,scope,{q:'Cash'},now),{items:[{id:1,name:'Cash'}],page:1,hasMore:false})
 await assert.rejects(()=>getCustomerPaymentTerms(f.db,scope,{q:'x'.repeat(101)},now),{status:400})
 f.db.companyModule.findMany=async()=>[{module_code:'contacts',status:'SUSPENDED'}]
 await assert.rejects(()=>getCustomerPaymentTerms(f.db,scope,{},now),{status:403})
})
