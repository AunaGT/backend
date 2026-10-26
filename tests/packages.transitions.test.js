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
test('package edit preserves a legacy reservation owned by another header but attached to its line',async()=>quoteHarness(async f=>{
  await existing(f,{complete:true})
  f.document().lines[0].reservations=[{id:id(601),document_id:id(602),status:'ACTIVE'}]
  const before=structuredClone(f.document())
  const out=await f.invoke('update',{items:[],packages:[f.selection()],expectedRevision:f.revision})
  assert.equal(out.error?.code,'PACKAGE_REVIEW_REQUIRED');assert.deepEqual(f.document(),before)
}))
test('editing an approved free line preserves agreed price and cannot reference another document or package component',async()=>quoteHarness(async f=>{
  await existing(f,{complete:true})
  f.document().lines.push({id:id(610),product_id:id(23),qty:'1',unit_price:'3.00',line_total:'3.00',item_name:'Artículo acordado',item_kind:'STANDARD',unit_label:'unidad',quantity_decimals:0,sort_order:3})
  f.document().total='1602.00';f.document().subtotal='1602.00'
  const payload={items:[{source_line_id:id(610),product_id:id(23),qty:'1'}],packages:[f.selection()],expectedRevision:f.revision}
  const out=await f.invoke('update',payload)
  assert.equal(out.error,undefined);assert.equal(String(f.document().lines[0].unit_price),'3.00')
  const before=structuredClone(f.document())
  const forged=await f.invoke('update',{...payload,expectedRevision:f.document().integration_revision,items:[{source_line_id:id(999),product_id:id(23),qty:'1'}]})
  assert.equal(forged.error?.code,'PACKAGE_REVIEW_REQUIRED');assert.deepEqual(f.document(),before)
}))
test('editing preview uses locked saved package agreement even after a newer version is active',async()=>quoteHarness(async f=>{
  await existing(f,{complete:true})
  f.state.versions.push({...structuredClone(f.state.versions[0]),version:2});f.state.packages[0].active_version=2
  const out=await f.invoke('previewPackages',{packages:[f.selection(),{...f.selection(),groupId:id(103),version:2}],quoteId:id(400),expectedRevision:f.revision})
  assert.equal(out.error,undefined);assert.equal(out.res.body.subtotal,'3198.00')
  const stale=await f.invoke('previewPackages',{packages:[f.selection()],quoteId:id(400),expectedRevision:id(999)})
  assert.equal(stale.error?.code,'DOCUMENT_CHANGED')
}))
test('JSONB key order does not turn the saved historical package into a new catalogue selection',async()=>quoteHarness(async f=>{
  await existing(f,{complete:true})
  const reordered=value=>Array.isArray(value)?value.map(reordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reordered(v)])):value
  f.document().package_groups=reordered(f.document().package_groups)
  f.state.versions.push({...structuredClone(f.state.versions[0]),version:2});f.state.packages[0].active_version=2
  const out=await f.invoke('previewPackages',{packages:[f.selection()],quoteId:id(400),expectedRevision:f.revision})
  assert.equal(out.error,undefined);assert.equal(out.res.body.packageGroups[0].amount,'1599.00')
}))
test('editing composition retains the agreed document discount and reallocates package net amounts',async()=>quoteHarness(async f=>{
  await existing(f,{complete:true})
  f.document().discount_total='99.00';f.document().total='1500.00'
  f.document().package_groups=packages.finalizePackageAmounts(f.document().package_groups,f.document().lines,{documentTotal:'1500.00'})
  const out=await f.invoke('update',{items:[],packages:[f.selection()],expectedRevision:f.revision})
  assert.equal(out.error,undefined);assert.equal(Number(f.document().discount_total),99)
  assert.equal(String(f.document().total),'1500');assert.equal(f.document().package_groups[0].netAmount,'1500.00')
  packages.assertPackageAgreement(f.document())
}))
