const test=require('node:test'),assert=require('node:assert/strict')
const {draftFixture}=require('./helpers/integrationDraftDb'),{scope,input,COMPANY,OWNER,BRANCH}=require('./helpers/integrationsDb')
const body={branchId:BRANCH,customerId:OWNER,items:[{productId:OWNER,quantity:'2'}]}
const now=new Date('2026-10-25T12:00:00Z'),key='checkout-request-123'
test('strict inputs and normalized idempotency hash never admit commercial authority',()=>{
 const {parseDraftInput,parseDraftKey,draftInputHash}=require('../src/modules/integrations/draftInput')
 for(const change of [{status:'CONFIRMED'},{companyId:COMPANY},{customer:{externalId:'x'}},{items:[{productId:OWNER,quantity:2}]},{items:[{productId:OWNER,quantity:'2',unitPrice:'1'}]},{notes:'x'.repeat(2001)}])assert.throws(()=>parseDraftInput({...body,...change}),{status:400})
 assert.throws(()=>parseDraftKey('short'),{status:400});assert.throws(()=>parseDraftKey('x'.repeat(101)),{status:400})
 assert.equal(draftInputHash('QUOTE',parseDraftInput(body)),draftInputHash('QUOTE',parseDraftInput({...body,items:[{quantity:'2.000',productId:OWNER.toUpperCase()}]})))
 assert.equal(parseDraftInput({...body,items:Array.from({length:100},()=>body.items[0])}).items.length,100)
 for(const items of [[],Array.from({length:101},()=>body.items[0]),[{productId:OWNER,quantity:'1e2'}],[{productId:OWNER,quantity:'0'}],[{productId:OWNER,quantity:'-1'}],[{productId:OWNER,quantity:'1.1234567890123'}]])assert.throws(()=>parseDraftInput({...body,items}),{status:400})
})
async function prepared(){const f=draftFixture();const created=await require('../src/modules/integrations/management').createCredential(f.db,scope,{...input,scopes:['quotes.create_draft','quotes.read']},now);return{...f,ctx:{credentialId:created.credential.id,companyId:COMPANY,integrationId:created.credential.integrationId}}}
test('duplicate requests persist one document and replay original receipt after manual edits',async()=>{
 const f=await prepared(),{createIntegrationDraft}=require('../src/modules/integrations/drafts')
 const out=await Promise.all(Array.from({length:10},()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now})))
 assert.equal(f.docs.length,1);assert.equal(out.filter(o=>!o.replayed).length,1);assert.equal(out[0].receipt.total,'25.00')
 f.docs[0].status='SENT';f.docs[0].total='99.00'
 const replay=await createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now});assert.equal(replay.receipt.status,'DRAFT');assert.equal(replay.receipt.total,'25.00')
 await assert.rejects(()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',{...body,notes:'different'},key,{now}),{status:409,integrationCode:'IDEMPOTENCY_CONFLICT'})
 assert.doesNotMatch(JSON.stringify(replay.receipt),/Ana|123-K|customer|notes|cost|token/i)
})
test('failure rolls back document, operation and audit; revoked keys cannot replay',async()=>{
 const f=await prepared(),{createIntegrationDraft}=require('../src/modules/integrations/drafts');f.breakAudit()
 await assert.rejects(()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now}));assert.equal(f.docs.length,0);assert.equal(f.operations.length,0)
 const g=await prepared();await createIntegrationDraft(g.db,g.ctx,'QUOTE',body,key,{now});g.rows[0].revoked_at=now
 await assert.rejects(()=>createIntegrationDraft(g.db,g.ctx,'QUOTE',body,key,{now}),{status:401})
})
test('revocation while waiting for a reference aborts immediately before insert',async()=>{
 const f=await prepared(),{createIntegrationDraft}=require('../src/modules/integrations/drafts')
 f.db.$executeRaw=async(_sql,...values)=>{if(values.some(v=>typeof v==='number'))f.rows[0].revoked_at=now;return 0}
 await assert.rejects(()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now}),{status:401});assert.equal(f.docs.length,0)
})
test('services disabled during preparation cannot be inserted under stale capabilities',async()=>{
 const f=await prepared(),{createIntegrationDraft}=require('../src/modules/integrations/drafts');let enabled=true
 f.db.systemSetting.findMany=async()=>[{key:'inventory_services_enabled',value:String(enabled)}]
 f.db.product.findFirst=async()=>{enabled=false;return{id:OWNER,company_id:COMPANY,name:'Servicio',kind:'SERVICE',service_unit_label:'hora',quantity_decimals:2,price:'12.50',available_for_sale:true,deleted:false,unit_metadata_version:1}}
 await assert.rejects(()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now}),{status:403});assert.equal(f.docs.length,0)
})
test('replay authorizes the moved document branch rather than a lost original branch',async()=>{
 const f=await prepared(),{createIntegrationDraft}=require('../src/modules/integrations/drafts'),second='55555555-5555-4555-8555-555555555555'
 const first=await createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now})
 f.docs[0].branch_id=second;f.operations[0].branch_id=second
 f.rows[0].branches.push({branch_id:second})
 f.db.userBranch.findMany=async()=>[{branch:{id:second,name:'Second',company_id:COMPANY,active:true}}]
 const replay=await createIntegrationDraft(f.db,f.ctx,'QUOTE',body,key,{now});assert.deepEqual(replay.receipt,first.receipt)
 await assert.rejects(()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',body,'new-invalid-branch-123',{now}),{status:403})
})
test('payment term removed while numbering rolls back the newly created customer',async()=>{
 const f=await prepared(),{createIntegrationDraft}=require('../src/modules/integrations/drafts');let active=true
 Object.assign(f.rows[0],{scopes:['quotes.create_draft','customers.create'],customer_policy:'CREATE_IF_MISSING',customer_payment_term_id:1})
 f.db.paymentTerm.findFirst=async()=>active?{id:1}:null
 f.db.$executeRaw=async(_sql,...values)=>{if(values.some(v=>typeof v==='number'))active=false;return 0}
 const {customerId,...request}=body
 await assert.rejects(()=>createIntegrationDraft(f.db,f.ctx,'QUOTE',{...request,customer:{externalId:'late-term',entityKind:'PERSON',name:'Ana',taxId:'CF'}},key,{now}),{status:403})
 assert.equal(f.docs.length,0);assert.equal(f.customers.length,1);assert.equal(f.refs.length,0)
})
module.exports={prepared,body,now,key}
