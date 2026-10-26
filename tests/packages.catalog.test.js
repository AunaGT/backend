const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture}=require('./helpers/packagesDb'),{id}=require('./helpers/packageFixtures')
const api=require('../src/modules/inventory/packages/catalog')
test('version is immutable and archive preserves the agreement version',async()=>{
  const f=fixture(),created=await api.savePackage(f.db,f.scope,null,f.input())
  const active=await api.activatePackageVersion(f.db,f.scope,created.id,{expectedVersion:created.version,idempotencyKey:randomUUID()})
  assert.equal(active.activeVersion,1)
  const before=structuredClone(f.state.versions[0]),next=f.input();next.expectedVersion=active.version;next.definition.variants[0].price='1999.00'
  const saved=await api.savePackage(f.db,f.scope,created.id,next)
  assert.deepEqual(f.state.versions[0],before)
  const v2=await api.activatePackageVersion(f.db,f.scope,created.id,{expectedVersion:saved.version,idempotencyKey:randomUUID()})
  assert.equal(v2.activeVersion,2);assert.equal(f.state.versions.length,2)
  await api.archivePackage(f.db,f.scope,created.id,{expectedVersion:v2.version,idempotencyKey:randomUUID()})
  assert.equal((await api.loadPackageVersion(f.db,f.scope,created.id,1,{forNewSelection:false})).definition.variants[0].price,'1599.00')
  await assert.rejects(api.loadPackageVersion(f.db,f.scope,created.id,2,{forNewSelection:true}),{code:'PACKAGE_UNAVAILABLE'})
})
test('stale write and repeated activation cannot overwrite or publish twice',async()=>{
  const f=fixture(),created=await api.savePackage(f.db,f.scope,null,f.input()),input={expectedVersion:created.version,idempotencyKey:randomUUID()}
  const a=await api.activatePackageVersion(f.db,f.scope,created.id,input),b=await api.activatePackageVersion(f.db,f.scope,created.id,input)
  assert.deepEqual(b,a);assert.equal(f.state.versions.length,1)
  await assert.rejects(api.savePackage(f.db,f.scope,created.id,{...f.input(),expectedVersion:created.version}),{code:'PACKAGE_CHANGED'})
})
test('lost create response does not create two packages and changed payload cannot reuse a key',async()=>{
  const f=fixture(),input=f.input(),a=await api.savePackage(f.db,f.scope,null,input),b=await api.savePackage(f.db,f.scope,null,input)
  assert.equal(a.id,b.id);assert.equal(f.state.packages.length,1)
  const changed=structuredClone(input);changed.definition.name='Otra configuración'
  await assert.rejects(api.savePackage(f.db,f.scope,null,changed),{code:'IDEMPOTENCY_CONFLICT'})
})
test('old save retry returns its receipt without overwriting a newer revision',async()=>{
  const f=fixture(),first=f.input(),created=await api.savePackage(f.db,f.scope,null,first),second=f.input()
  second.expectedVersion=created.version;second.definition.name='Revisión dos'
  const newer=await api.savePackage(f.db,f.scope,created.id,second)
  assert.deepEqual(await api.savePackage(f.db,f.scope,null,first),created)
  const current=await api.getPackage(f.db,f.scope,created.id)
  assert.equal(current.version,newer.version);assert.equal(current.definition.name,'Revisión dos')
})
test('known foreign references are rejected and incomplete draft cannot be activated',async()=>{
  const f=fixture(),input=f.input();input.definition.variants[0].components[0].productId=id(900)
  await assert.rejects(api.savePackage(f.db,f.scope,null,input),{status:404})
  assert.equal(f.state.packages.length,0)
  const draft=f.input();draft.definition.variants=[]
  const created=await api.savePackage(f.db,f.scope,null,draft)
  await assert.rejects(api.activatePackageVersion(f.db,f.scope,created.id,{expectedVersion:created.version,idempotencyKey:randomUUID()}),{status:400})
  assert.equal(f.state.versions.length,0)
})
test('choice options must share real units and product revisions, not just a display label',async()=>{
  const f=fixture(),input=f.input()
  f.state.products.find(p=>p.id===id(22)).quantity_decimals=2
  await assert.rejects(api.savePackage(f.db,f.scope,null,input),{code:'PACKAGE_UNITS_MISMATCH'})
  f.state.products.find(p=>p.id===id(22)).quantity_decimals=0;f.state.products.find(p=>p.id===id(21)).unit_revision=2
  await assert.rejects(api.savePackage(f.db,f.scope,null,f.input()),{code:'UNIT_REVISION_CONFLICT'})
})
test('list is branch scoped, bounded and does not create a catalog outside inventory',async()=>{
  const f=fixture(),a=await api.savePackage(f.db,f.scope,null,f.input())
  const other=f.input();other.branchIds=[id(203)];await api.savePackage(f.db,f.scope,null,other)
  const list=await api.listPackages(f.db,f.scope,{limit:'1'})
  assert.equal(list.items.length,1);assert.equal(list.items[0].id,a.id)
  await assert.rejects(api.listPackages(f.db,f.scope,{limit:'101'}),{status:400})
  await assert.rejects(api.listPackages(f.db,f.scope,{branchId:id(999)}),{status:403})
  f.state.modules.push({company_id:f.scope.companyId,module_code:'inventory',status:'DISABLED'})
  await assert.rejects(api.getPackage(f.db,f.scope,a.id),{code:'MODULE_DISABLED'})
})
