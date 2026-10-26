const test=require('node:test'),assert=require('node:assert/strict')
const {id}=require('./helpers/packageFixtures')
const {quoteHarness}=require('./helpers/packageQuoteHarness')
const packages=require('../src/services/commercialPackages')
const partial=f=>f.selection([{optionId:id(4),quantity:'80'}])
async function existing(f,{complete=false,status='DRAFT'}={}){
  const built=await packages.buildPackageGroups(f.db,f.scope,[complete?f.selection():partial(f)],{allowIncomplete:true})
  f.setDocument({id:id(400),doc_type:'QUOTE',branch_id:f.scope.branchId,integration_revision:f.revision,status,public_token:status==='SENT'?'token':null,
    customer_contact_id:null,documentSales:[],convertedChildren:[],quoted_engagement:null,stock_reservations:[],
    package_groups:built.groups,lines:built.lines,subtotal:built.subtotal,total:built.subtotal,discount_total:'0.00'})
}
test('quotation creation persists incomplete selection as draft with no posting lines or stock writes',async()=>quoteHarness(async f=>{
  const {res,error}=await f.invoke('create',{items:[],packages:[partial(f)]})
  assert.equal(error,undefined);assert.equal(res.statusCode,201)
  assert.equal(f.document().status,'DRAFT');assert.equal(f.document().package_groups[0].state,'INCOMPLETE')
  assert.equal(f.document().total,'0');assert.deepEqual(f.document().lines,[]);assert.equal(f.stockWrites(),0)
}))
test('old item-only clients cannot silently remove internally agreed package groups',async()=>quoteHarness(async f=>{
  await existing(f,{complete:true});const before=structuredClone(f.document())
  const {error}=await f.invoke('update',{items:[{product_id:id(21),qty:'1'}]})
  assert.equal(error?.code,'PACKAGE_REVIEW_REQUIRED');assert.deepEqual(f.document(),before)
}))
test('package composition replacement requires current revision and explicit empty selection removes group',async()=>quoteHarness(async f=>{
  await existing(f);const before=structuredClone(f.document())
  let out=await f.invoke('update',{items:[],packages:[partial(f)]})
  assert.equal(out.error?.status,428);assert.deepEqual(f.document(),before)
  out=await f.invoke('update',{items:[],packages:[partial(f)],expectedRevision:id(999)})
  assert.equal(out.error?.status,409);assert.deepEqual(f.document(),before)
  out=await f.invoke('update',{items:[],packages:[f.selection()],expectedRevision:f.revision})
  assert.equal(out.error,undefined);assert.equal(f.document().package_groups[0].state,'COMPLETE');assert.equal(f.document().lines.length,3)
  // A quote cannot be left entirely empty by removing its final package.
  out=await f.invoke('update',{items:[],packages:[],expectedRevision:f.document().integration_revision})
  assert.equal(out.error?.status,400);assert.equal(f.document().package_groups.length,1)
}))
test('incomplete package cannot be sent, accepted or shared, including public-token response',async()=>{
  for(const [method,body,status]of [['updateStatus',{status:'SENT'},'DRAFT'],['updateStatus',{status:'ACCEPTED'},'SENT'],['getShareLink',{},'DRAFT'],['respondPublic',{status:'ACCEPTED'},'SENT']]){
    await quoteHarness(async f=>{await existing(f,{status});const before=structuredClone(f.document());const {res,error}=await f.invoke(method,body)
      assert.equal(error?.code,'PACKAGE_SELECTION_INCOMPLETE',`${method}: ${error?.message||JSON.stringify(res.body)}`)
      assert.deepEqual(f.document(),before);assert.equal(f.stockWrites(),0)
    })
  }
})
test('Agenda and both quote conversions reject incomplete source agreement before creating destination',async()=>quoteHarness(async f=>{
  await existing(f,{status:'ACCEPTED'})
  await assert.rejects(()=>require('../src/modules/quotes').loadQuoteSource(f.db,{...f.scope,isAdmin:true},id(400)),{code:'PACKAGE_SELECTION_INCOMPLETE'})
  const {error}=await f.invoke('convertToOrder',{})
  assert.equal(error?.code,'PACKAGE_SELECTION_INCOMPLETE');assert.equal(f.stockWrites(),0)
  f.db.branch.findFirst=async()=>({id:f.scope.branchId,code:'T',seq:1})
  await assert.rejects(()=>require('../src/modules/quotes/saleDraft').createQuoteSaleDraft(f.db,{...f.scope,isAdmin:true,userId:f.scope.actorId},id(400)),{code:'PACKAGE_SELECTION_INCOMPLETE'})
}))
test('preview is authorized and returns amounts/composition without persisting a document',async()=>quoteHarness(async f=>{
  const out=await f.invoke('previewPackages',{packages:[f.selection()]})
  assert.equal(out.error,undefined);assert.equal(out.res.body.subtotal,'1599.00');assert.equal(out.res.body.items.length,3)
  assert.equal(f.document(),null);assert.equal(f.stockWrites(),0)
  assert.doesNotMatch(JSON.stringify(out.res.body),/unit_cost|base_unit_cost|weight/)
  f.scope.permissions.splice(f.scope.permissions.indexOf('products.view'),1)
  const denied=await f.invoke('previewPackages',{packages:[f.selection()]})
  assert.equal(denied.error?.status,403)
}))
test('share rechecks locked agreement when packages were added after the initial lookup',async()=>quoteHarness(async f=>{
  await existing(f)
  const find=f.db.commercialDocument.findFirst;let first=true
  f.db.commercialDocument.findFirst=async query=>{const row=await find(query);if(first){first=false;return{...row,package_groups:null}}return row}
  const out=await f.invoke('getShareLink',{})
  assert.equal(out.error?.code,'PACKAGE_SELECTION_INCOMPLETE');assert.equal(f.document().public_token,null)
}))
