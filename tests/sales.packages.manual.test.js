const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {manualHarness}=require('./helpers/manualSalesHarness.cjs'),{withMocks}=require('./helpers/reportHarness.cjs')
const {agreementFixture}=require('./helpers/packageAgreementFixture')
async function fixture(){
 const h=manualHarness(),f=await agreementFixture()
 Object.assign(h.scope,{companyId:f.scope.companyId,branchId:f.scope.branchId,userId:f.scope.actorId})
 h.product.company_id=h.scope.companyId;h.customer.company_id=h.scope.companyId;h.settings.currency_code='GTQ'
 for(const key of ['commercialPackage','commercialPackageVersion','commercialPackageBranch','commercialPackageCommand','companyModule'])h.db[key]=f.db[key]
 h.db.product.findMany=async({where})=>[h.product,...f.state.products].filter(p=>p.company_id===where.company_id&&(!where.id?.in||where.id.in.includes(p.id))&&(!Object.hasOwn(where,'deleted')||p.deleted===where.deleted))
 return{h,f,input:()=>({...h.input(),items:[],packages:[f.selection()]})}
}
const target=require.resolve('../src/modules/sales/manualSales')
test('manual package-only preview/save/reopen keeps one agreed price and actual components without dispatching',async()=>{
 const {h,f,input}=await fixture()
 await withMocks(h.mocks,target,async api=>{
  const raw=input(),preview=await api.previewManualSale(h.db,h.scope,raw)
  assert.equal(preview.total,'1599.00');assert.equal(preview.items.length,0);assert.equal(preview.packageGroups.length,1)
  const saved=await api.saveManualSale(h.db,h.scope,null,raw)
  assert.equal(saved.total,'1599.00');assert.equal(saved.items.length,3);assert.equal(saved.packageGroups[0].variantName,'160 unidades')
  assert.ok(saved.items.every(l=>l.packageComponentKey));assert.deepEqual(h.state.effects,[])
  assert.deepEqual(await api.readManualSale(h.db,h.scope,saved.id),saved)
  const updated=await api.saveManualSale(h.db,h.scope,saved.id,{...input(),expectedVersion:saved.version,customerName:'Nombre acordado'})
  assert.equal(updated.total,'1599.00');assert.equal(updated.items.length,3);assert.equal(updated.customerName,'Nombre acordado')
  assert.deepEqual(h.state.effects,[])
  const done=await api.confirmManualSale(h.db,h.scope,saved.id,{expectedVersion:updated.version,idempotencyKey:randomUUID(),dueDate:'2099-01-01'})
  assert.equal(done.status,'CONFIRMED');assert.equal(done.total,'1599.00');assert.equal(done.packageGroups[0].packageId,f.packageId)
  assert.deepEqual(h.state.effects,['availability','stock','accounting'])
 })
})
test('a mixed direct draft keeps independent items separate from generated package components',async()=>{
 const {h,input}=await fixture()
 await withMocks(h.mocks,target,async api=>{
  const raw={...input(),items:h.input().items},preview=await api.previewManualSale(h.db,h.scope,raw)
  assert.equal(preview.items.length,1);assert.equal(preview.total,'1611.81')
  const saved=await api.saveManualSale(h.db,h.scope,null,raw)
  assert.equal(saved.items.length,4);assert.equal(saved.items.filter(l=>l.packageComponentKey).length,3)
  assert.equal(saved.total,'1611.81')
 })
})
