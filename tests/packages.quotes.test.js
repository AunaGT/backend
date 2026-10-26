const test=require('node:test'),assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {agreementFixture}=require('./helpers/packageAgreementFixture')
const {id}=require('./helpers/packageFixtures')
const packages=require('../src/services/commercialPackages')
const catalog=require('../src/modules/inventory/packages/catalog')

test('incomplete draft keeps agreed missing quantities but has no posting lines or finished amount',async()=>{
  const f=await agreementFixture(),result=await packages.buildPackageGroups(f.db,f.scope,[f.selection([{optionId:id(4),quantity:'80'}])],{allowIncomplete:true})
  assert.deepEqual(result.lines,[]);assert.equal(result.subtotal,'0.00')
  assert.equal(result.groups[0].state,'INCOMPLETE');assert.equal(result.groups[0].amount,null)
  assert.equal(result.groups[0].estimatedAmount,'1599.00');assert.equal(result.groups[0].issues[0].remainingQuantity,'80')
  assert.throws(()=>packages.assertPackageAgreement({package_groups:result.groups,lines:[],total:'0.00'},{requireComplete:true}),{code:'PACKAGE_SELECTION_INCOMPLETE'})
  packages.assertPackageAgreement({package_groups:result.groups,lines:[],total:'0.00'},{requireComplete:false})
})
test('complete selection allocates revenue only to actual products and service, not package heading',async()=>{
  const f=await agreementFixture(),out=await packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  assert.equal(out.lines.length,3);assert.equal(out.subtotal,'1599.00')
  assert.deepEqual(out.lines.map(l=>[l.product_id,l.qty,l.line_total]),[[id(20),'1','319.80'],[id(21),'80','639.60'],[id(22),'80','639.60']])
  assert.ok(out.lines.every(l=>l.package_component_key.startsWith(id(100)+':')))
  assert.ok(out.lines.every(l=>!Object.hasOwn(l,'unit_cost')&&!Object.hasOwn(l,'base_unit_cost')))
  assert.equal(out.groups[0].netAmount,'1599.00')
  packages.assertPackageAgreement({package_groups:out.groups,lines:out.lines,subtotal:'1599.00',total:'1599.00'},{requireComplete:true})
})
test('unchanged selection keeps original price and name after newer catalog publication',async()=>{
  const f=await agreementFixture(),original=await packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  const draft=await catalog.getPackage(f.db,f.scope,f.packageId),definition=structuredClone(draft.definition)
  definition.name='Paquete nuevo';definition.variants[0].price='1999.00'
  const saved=await catalog.savePackage(f.db,f.scope,f.packageId,{expectedVersion:draft.version,definition,branchIds:[f.scope.branchId],idempotencyKey:randomUUID()})
  await catalog.activatePackageVersion(f.db,f.scope,f.packageId,{expectedVersion:saved.version,idempotencyKey:randomUUID()})
  const unchanged=await packages.buildPackageGroups(f.db,f.scope,[f.selection()],{existingGroups:original.groups,allowIncomplete:true})
  assert.equal(unchanged.subtotal,'1599.00');assert.equal(unchanged.groups[0].name,'Paquete de evento')
  const changed=f.selection([{optionId:id(4),quantity:'160'}])
  await assert.rejects(()=>packages.buildPackageGroups(f.db,f.scope,[changed],{existingGroups:original.groups,allowIncomplete:true}),{status:409,code:'PACKAGE_UNAVAILABLE'})
  const next=await packages.buildPackageGroups(f.db,f.scope,[{...changed,version:2}],{allowIncomplete:true})
  assert.equal(next.subtotal,'1999.00')
})
test('global discount allocation includes free lines and conserves cents without double discount',async()=>{
  const f=await agreementFixture(),out=await packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  const lines=[{product_id:id(23),qty:'1',unit_price:'1',line_total:'1.00'},...out.lines]
  const groups=packages.finalizePackageAmounts(out.groups,lines,{documentTotal:'1440.00'})
  assert.equal(groups[0].amount,'1599.00');assert.equal(groups[0].netAmount,'1439.10')
  assert.deepEqual(groups[0].components.map(c=>c.netLineTotal),['287.82','575.64','575.64'])
  packages.assertPackageAgreement({package_groups:groups,lines,subtotal:'1600.00',discount_total:'160.00',total:'1440.00'},{requireComplete:true})
})
test('closing checks individual identity, quantity, unit and amount, not only matching header total',async()=>{
  const f=await agreementFixture(),out=await packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  for(const change of [l=>{l.product_id=id(23)},l=>{l.qty='81'},l=>{l.unit_label='otra'},l=>{l.line_total='639.59'},l=>{l.unit_price='0'},l=>{l.package_component_key=id(301)+':'+id(4)}]){
    const lines=structuredClone(out.lines);change(lines[1])
    assert.throws(()=>packages.assertPackageAgreement({package_groups:out.groups,lines,total:'1599.00'},{requireComplete:true}),{status:409,code:'PACKAGE_REVIEW_REQUIRED'})
  }
  assert.throws(()=>packages.assertPackageAgreement({package_groups:out.groups,lines:[...out.lines,out.lines[1]],total:'2238.60'},{requireComplete:true}),{code:'PACKAGE_REVIEW_REQUIRED'})
})
test('free item input cannot impersonate a package component or submit its snapshot',()=>{
  for(const key of ['package_component_key','package_groups','packageGroups','packageId','packageSnapshot'])
    assert.throws(()=>packages.assertFreePackageItems([{product_id:id(20),qty:'1',[key]:'forged'}]),{status:400})
})
test('package public projection excludes private data at every level and returns a detached snapshot',async()=>{
  const f=await agreementFixture(),out=await packages.buildPackageGroups(f.db,f.scope,[f.selection()],{allowIncomplete:true})
  out.groups[0].cost='secret';out.groups[0].components[0].weight='private';out.groups[0].components[0].serviceConditions={version:1,schedulingStyle:'WORK',durationPolicy:'FIXED',durationMinutes:60,allowedVenueKinds:['EVENT_VENUE'],publicInstructions:'Acceso',providers:['private']}
  const publicGroups=packages.publicPackageGroups(out.groups)
  assert.doesNotMatch(JSON.stringify(publicGroups),/secret|private|weight|cost|providers|"selection"|unitSnapshot|unitRevision/)
  assert.equal(publicGroups[0].components[0].serviceConditions.publicInstructions,'Acceso')
  publicGroups[0].name='Otro';assert.equal(out.groups[0].name,'Paquete de evento')
})
