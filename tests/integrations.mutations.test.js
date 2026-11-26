const test=require('node:test'),assert=require('node:assert/strict')
const {draftFixture}=require('./helpers/integrationDraftDb'),{scope,input,OWNER,BRANCH}=require('./helpers/integrationsDb')
const {createCredential}=require('../src/modules/integrations/management'),{authenticateIntegration}=require('../src/modules/integrations/auth'),{createIntegrationDraft}=require('../src/modules/integrations/drafts'),{formatDocumentVersion}=require('../src/modules/integrations/draftDocument')
const now=new Date('2026-10-26T12:00:00Z'),key='mutation-request-12345'
async function setup(type='QUOTE'){
 const f=draftFixture(),prefix=type==='QUOTE'?'quotes':'orders'
 const credential=await createCredential(f.db,scope,{...input,scopes:[prefix+'.read',prefix+'.create_draft',prefix+'.update_draft',prefix+'.cancel_draft']},now),ctx=await authenticateIntegration(f.db,'Bearer '+credential.apiKey,now)
 const original=await createIntegrationDraft(f.db,ctx,type,{branchId:BRANCH,customerId:OWNER,items:[{productId:OWNER,quantity:'1'}]},'original-request-12345',{now})
 const version=()=>`"${formatDocumentVersion(f.docs[0].integration_revision)}"`
 return{...f,ctx,type,id:original.receipt.id,original:original.receipt,version}
}
function mutate(f,action,body,version=f.version(),requestKey=key){return require('../src/modules/integrations/draftMutations').mutateIntegrationDraft(f.db,f.ctx,f.type,f.id,action,body,requestKey,version,{now})}
test('older API edits preserve agreed event terms and rebase only server totals; clients cannot inject a policy',async()=>{
 const f=await setup(),terms={schemaVersion:1,depositPercent:'25.00',balanceDaysBefore:3,referenceStartsAt:'2027-01-10T16:00:00Z',referenceTimezone:'America/Guatemala',basisTotal:'12.50',currencyCode:'GTQ'}
 f.docs[0].event_payment_terms=terms
 await mutate(f,'UPDATE_DRAFT',{notes:'Keep the agreement'})
 assert.deepEqual(f.docs[0].event_payment_terms,terms)
 const read=f.db.product.findFirst
 f.db.product.findFirst=async args=>({...await read(args),kind:'SERVICE',service_unit_label:'hora',quantity_decimals:2})
 f.db.systemSetting.findMany=async()=>[{key:'inventory_services_enabled',value:'true'}]
 await mutate(f,'UPDATE_DRAFT',{items:[{productId:OWNER,quantity:'2'}]},f.version(),key+'-services')
 assert.equal(f.docs[0].event_payment_terms.basisTotal,'25.00');assert.equal(f.docs[0].event_payment_terms.depositPercent,'25.00')
 assert.equal(f.docs[0].event_payment_terms.currencyCode,'GTQ')
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{eventPaymentTerms:null}),{status:400})
 f.db.product.findFirst=read
 const before=structuredClone(f.docs[0])
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{items:[{productId:OWNER,quantity:'1'}]},f.version(),key+'-goods'),{code:'EVENT_TERMS_REQUIRE_SERVICE'})
 assert.deepEqual(f.docs[0],before)
})
test('notes-only never reads catalog or reprices; null clears without changing original receipt',async()=>{
 const f=await setup(),lines=structuredClone(f.docs[0].lines),receipt=structuredClone(f.operations[0].receipt)
 f.db.product.findFirst=async()=>{throw Error('notes must not read catalog')}
 const out=await mutate(f,'UPDATE_DRAFT',{notes:' hello '})
 assert.equal(out.replayed,false);assert.equal(f.docs[0].notes,'hello');assert.equal(out.receipt.total,'12.50');assert.equal(out.receipt.status,'DRAFT');assert.match(out.receipt.version,/^auna-draft-v1:/)
 assert.deepEqual(f.docs[0].lines,lines);assert.deepEqual(f.operations[0].receipt,receipt);assert.doesNotMatch(JSON.stringify(out.receipt),/hello|notes|customer|token/)
 await mutate(f,'UPDATE_DRAFT',{notes:null},f.version(),key+'-clear');assert.equal(f.docs[0].notes,null)
 assert.equal(f.events.filter(e=>e.action==='UPDATE_DRAFT').length,2);assert.equal(f.mutations.length,2)
 assert.ok(f.events.filter(e=>e.action==='UPDATE_DRAFT').every(e=>e.route==='/quotes/:id'&&e.status===200))
})
test('item replacement reuses exact public builder, ignores client pricing and preserves original currency',async()=>{
 const f=await setup('ORDER'),read=f.db.product.findFirst
 f.db.product.findFirst=async args=>({...await read(args),price:'2.30',price_promotion:'1.10'})
 f.db.systemSetting.findMany=async()=>[{key:'currency_code',value:'USD'}]
 const out=await mutate(f,'UPDATE_DRAFT',{items:[{productId:OWNER,quantity:'3'}],notes:null})
 assert.equal(out.receipt.total,'3.30');assert.equal(out.receipt.currency,'GTQ');assert.equal(f.docs[0].lines[0].qty,'3');assert.equal(f.docs[0].lines[0].unit_price,'1.1');assert.equal(f.docs[0].discount_total,'0.00')
 assert.equal(f.events.at(-1).route,'/orders/:id')
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{items:[{productId:OWNER,quantity:'1',unitPrice:'0'}]}),{status:400})
})
test('discard keeps lines, original receipt and history; lost-response replay survives later discard',async()=>{
 const f=await setup(),version=f.version(),body={notes:'one'},first=await mutate(f,'UPDATE_DRAFT',body,version),lines=structuredClone(f.docs[0].lines)
 await mutate(f,'UPDATE_DRAFT',{notes:'two'},f.version(),key+'-two')
 const cancel=await mutate(f,'CANCEL_DRAFT',{},f.version(),key+'-cancel');assert.equal(cancel.receipt.status,'CANCELLED')
 assert.deepEqual(f.docs[0].lines,lines);assert.deepEqual(f.operations[0].receipt,f.original)
 const replay=await mutate(f,'UPDATE_DRAFT',body,version);assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,first.receipt)
 assert.equal(f.events.filter(e=>e.action==='UPDATE_DRAFT').length,2);assert.equal(f.events.filter(e=>e.action==='CANCEL_DRAFT').length,1);assert.equal(f.events.at(-1).action,'USE');assert.equal(f.events.at(-1).status,200)
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',body,f.version()),{status:409,integrationCode:'IDEMPOTENCY_CONFLICT'})
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'other'},version),{status:409,integrationCode:'IDEMPOTENCY_CONFLICT'})
})
test('eligible stale version is 412, operational/private document is 409 first, no read/write outside current branch',async()=>{
 const f=await setup(),old=f.version();await mutate(f,'UPDATE_DRAFT',{notes:'new'})
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'stale'},old,key+'-stale'),{status:412,integrationCode:'VERSION_CONFLICT'})
 f.docs[0].payment_condition='CREDIT'
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'stale'},old,key+'-review'),{status:409,integrationCode:'DOCUMENT_REVIEW_REQUIRED'})
 f.docs[0].branch_id=OWNER
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'new'},old),{status:404})
})
test('audit failure restores header/lines/version/receipt and leaves key retryable',async()=>{
 const f=await setup(),before=structuredClone(f.docs[0]),events=f.events.length
 f.breakAudit()
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{items:[{productId:OWNER,quantity:'2'}]}),/audit failure/)
 assert.deepEqual(f.docs[0],before);assert.equal(f.mutations.length,0);assert.equal(f.events.length,events)
})
test('fresh context and active tenant contact are required without customers.create',async()=>{
 const f=await setup();f.customers[0].estado=0
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'hello'}),{status:409,integrationCode:'CUSTOMER_REVIEW_REQUIRED'})
 f.customers[0].estado=1;f.rows[0].scopes=['quotes.read','quotes.cancel_draft']
 await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'hello'}),{status:403})
 assert.equal((await mutate(f,'CANCEL_DRAFT',{})).receipt.status,'CANCELLED');assert.equal(f.customers.length,1)
})
test('late pause or service disable cannot commit prepared replacement lines',async()=>{
 for(const reason of ['pause','service']){
  const f=await setup(),before=structuredClone(f.docs[0]);let enabled=true
  f.db.systemSetting.findMany=async()=>[{key:'inventory_services_enabled',value:String(enabled)}]
  f.db.product.findFirst=async()=>{if(reason==='pause')f.rows[0].paused_at=now;else enabled=false;return{id:OWNER,company_id:f.ctx.companyId,name:'Servicio',kind:'SERVICE',service_unit_label:'hora',quantity_decimals:2,price:'12.50',available_for_sale:true,deleted:false,unit_metadata_version:1}}
  await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{items:[{productId:OWNER,quantity:'2'}]}),{status:reason==='pause'?401:403})
  assert.deepEqual(f.docs[0],before);assert.equal(f.mutations.length,0)
 }
})
test('a different document/action has its own key and replacement identity can replay',async()=>{
 const f=await setup(),version=f.version(),first=await mutate(f,'UPDATE_DRAFT',{notes:'one'},version)
 const {replaceCredential}=require('../src/modules/integrations/management'),replacement=await replaceCredential(f.db,scope,f.ctx.credentialId,{...input,scopes:f.rows[0].scopes},now)
 f.ctx=await authenticateIntegration(f.db,'Bearer '+replacement.apiKey,now)
 assert.deepEqual((await mutate(f,'UPDATE_DRAFT',{notes:'one'},version)).receipt,first.receipt)
 assert.equal((await mutate(f,'CANCEL_DRAFT',{},f.version())).replayed,false)
 assert.equal(f.mutations.length,2)
})
test('authorization is checked again after waiting on the final customer lock',async()=>{
 for(const reason of ['expiry','role']){
  const f=await setup(),before=structuredClone(f.docs[0]),execute=f.db.$executeRaw
  f.db.$executeRaw=async(strings,...values)=>{
   if(strings.join('').includes('public.suppliers')){
    if(reason==='expiry')f.rows[0].expires_at=new Date(now.getTime()-1)
    else f.db.userCompany.findUnique=async()=>({status:'ACTIVE',company:{active:true},user:{name:'Ana'},role:{name:'Restricted',permissions:[]}})
   }
   return execute(strings,...values)
  }
  await assert.rejects(()=>mutate(f,'UPDATE_DRAFT',{notes:'must roll back'}),{status:reason==='expiry'?401:403})
  assert.deepEqual(f.docs[0],before);assert.equal(f.mutations.length,0)
 }
})
