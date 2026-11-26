const test=require('node:test'),assert=require('node:assert/strict')
const {parseCreateInput}=require('../src/modules/integrations/credentials')
const {effectiveScopes,revalidateDocumentContext}=require('../src/modules/integrations/policy')
const {parseDraftInput,parseDraftItems}=require('../src/modules/integrations/draftInput')
const {fixture,input,COMPANY,BRANCH}=require('./helpers/integrationsDb')
const mutation=()=>require('../src/modules/integrations/draftMutationInput')
const ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',VERSION=`auna-draft-v1:${ID}`
const item={productId:ID,quantity:'1.2500',presentationId:null,unitRevision:1}
const principal={isAdmin:false,permissions:['quotes.view','quotes.create','quotes.manage','orders.view','orders.create','orders.manage','products.view','contacts.clients.view'],enabledModules:['quotes','orders','inventory'],inventoryEnabled:true}
test('mutation scopes require explicitly selected read without granting customer creation',()=>{
 for(const type of ['quotes','orders'])for(const action of ['update_draft','cancel_draft']){
  const scope=`${type}.${action}`,read=`${type}.read`
  assert.throws(()=>parseCreateInput({...input,scopes:[scope]}),{status:400})
  assert.deepEqual(parseCreateInput({...input,scopes:[scope,read]}).scopes,[scope,read])
  assert.deepEqual(effectiveScopes(principal,[scope]),[])
  assert.deepEqual(effectiveScopes(principal,[scope,read]),[scope,read])
  assert.deepEqual(effectiveScopes({...principal,permissions:principal.permissions.filter(p=>p!==`${type}.view`)},[scope,read]),[])
 }
})
test('cancel needs manage, not catalog or customer creation; update needs catalog and contact read',()=>{
 for(const type of ['quotes','orders']){
  const read=`${type}.read`,update=`${type}.update_draft`,cancel=`${type}.cancel_draft`
  assert.deepEqual(effectiveScopes({...principal,permissions:[`${type}.view`,`${type}.manage`]},[read,cancel,update]),[read,cancel])
  assert.deepEqual(effectiveScopes({...principal,permissions:[`${type}.view`,`${type}.create`,'products.view','contacts.clients.view']},[read,update,cancel]),[read,update])
  for(const lost of ['products.view','contacts.clients.view'])assert.deepEqual(effectiveScopes({...principal,permissions:principal.permissions.filter(p=>p!==lost)},[read,update]),[read])
 }
})
test('mutation authorization revalidates grants, branch, identity and action',async()=>{
 const f=fixture(),now=new Date('2026-10-26T12:00:00Z')
 f.rows.push({id:ID,company_id:COMPANY,integration_id:ID,owner_id:input.ownerId,scopes:['quotes.read','quotes.cancel_draft'],branches:[{branch_id:BRANCH}],expires_at:null,revoked_at:null,paused_at:null})
 const ctx={credentialId:ID,companyId:COMPANY,integrationId:ID}
 assert.ok((await revalidateDocumentContext(f.db,ctx,'QUOTE','CANCEL_DRAFT',BRANCH,now)).scopes.includes('quotes.cancel_draft'))
 for(const [type,action,branch] of [['QUOTE','UPDATE_DRAFT',BRANCH],['ORDER','CANCEL_DRAFT',BRANCH],['QUOTE','OTHER',BRANCH],['QUOTE','CANCEL_DRAFT',ID]])await assert.rejects(()=>revalidateDocumentContext(f.db,ctx,type,action,branch,now),{status:403})
 f.rows[0].scopes=['quotes.cancel_draft']
 await assert.rejects(()=>revalidateDocumentContext(f.db,ctx,'QUOTE','CANCEL_DRAFT',BRANCH,now),{status:403})
})
test('notes null clears, trimmed text is bounded; empty or unknown mutation is invalid',()=>{
 const {parseMutationInput}=mutation()
 assert.deepEqual(parseMutationInput('UPDATE_DRAFT',{notes:null}),{notes:null})
 assert.deepEqual(parseMutationInput('UPDATE_DRAFT',{notes:' hello\nworld '}),{notes:'hello\nworld'})
 assert.equal(parseMutationInput('UPDATE_DRAFT',{notes:'a'.repeat(2000)}).notes.length,2000)
 for(const raw of [{},{notes:''},{notes:' '},{notes:'a'.repeat(2001)},{notes:'a\u0000'},null,[],1])assert.throws(()=>parseMutationInput('UPDATE_DRAFT',raw),{status:400})
 assert.deepEqual(parseMutationInput('CANCEL_DRAFT',{}),{})
 for(const raw of [null,[],{notes:null},{items:[]}])assert.throws(()=>parseMutationInput('CANCEL_DRAFT',raw),{status:400})
 assert.throws(()=>parseMutationInput('OTHER',{}),{status:400})
})
test('items use the exact creation contract; reject overrides, inherited fields and unsafe quantities',()=>{
 const {parseMutationInput}=mutation(),items=[item]
 assert.deepEqual(parseMutationInput('UPDATE_DRAFT',{items}).items,parseDraftInput({branchId:BRANCH,customerId:ID,items}).items)
 assert.deepEqual(parseDraftItems(items),[{...item,quantity:'1.25'}])
 assert.equal(parseDraftItems(Array.from({length:100},()=>item)).length,100)
 for(const raw of [null,[],Array.from({length:101},()=>item),[null],[[]],...['0',0,1,NaN,Infinity,'Infinity','-1','1e2','1.0000000000001'].map(quantity=>[{...item,quantity}]),[{...item,price:0}],[Object.assign(Object.create({price:0}),item)]])assert.throws(()=>parseDraftItems(raw),{status:400})
 for(const field of ['customerId','branchId','currency','discount','price','status','externalReference','__proto__']){
  const raw=JSON.parse(`{"notes":"hello","${field}":"bad"}`)
  assert.throws(()=>parseMutationInput('UPDATE_DRAFT',raw),{status:400})
 }
 assert.throws(()=>parseMutationInput('UPDATE_DRAFT',Object.assign(Object.create({status:'DRAFT'}),{notes:'hello'})),{status:400})
})
test('If-Match requires exactly one strong opaque version; hash includes original precondition',()=>{
 const {parseIfMatch,mutationInputHash}=mutation()
 assert.equal(parseIfMatch(`"${VERSION.toUpperCase().replace('AUNA-DRAFT-V1','auna-draft-v1')}"`),VERSION)
 for(const absent of [undefined,null,''])assert.throws(()=>parseIfMatch(absent),{status:428,integrationCode:'PRECONDITION_REQUIRED'})
 for(const bad of ['*',VERSION,`W/"${VERSION}"`,`"${VERSION}", "${VERSION}"`,['x'],`"auna-draft-v1:invalid"`,` "${VERSION}" `])assert.throws(()=>parseIfMatch(bad),{status:412,integrationCode:'VERSION_CONFLICT'})
 const hash=mutationInputHash('QUOTE',ID,'UPDATE_DRAFT',{items:parseDraftItems([item]),notes:null},VERSION)
 assert.match(hash,/^[a-f0-9]{64}$/)
 assert.equal(hash,mutationInputHash('QUOTE',ID,'UPDATE_DRAFT',{notes:null,items:parseDraftItems([item])},VERSION))
 for(const args of [['ORDER',ID,'UPDATE_DRAFT',{items:parseDraftItems([item]),notes:null},VERSION],['QUOTE',BRANCH,'UPDATE_DRAFT',{items:parseDraftItems([item]),notes:null},VERSION],['QUOTE',ID,'CANCEL_DRAFT',{},VERSION],['QUOTE',ID,'UPDATE_DRAFT',{items:parseDraftItems([item]),notes:null},`auna-draft-v1:${BRANCH}`]])assert.notEqual(mutationInputHash(...args),hash)
})
