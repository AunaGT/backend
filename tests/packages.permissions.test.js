const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture}=require('./helpers/packagesDb'),{id}=require('./helpers/packageFixtures')
const api=require('../src/modules/inventory/packages/catalog')
test('shared package requires access to all assigned branches before changing it',async()=>{
  const f=fixture(),input=f.input();input.branchIds=[f.scope.branchId,id(203)]
  const created=await api.savePackage(f.db,f.scope,null,input)
  const restricted={...f.scope,branchIds:[f.scope.branchId]}
  assert.equal((await api.getPackage(f.db,restricted,created.id)).id,created.id)
  await assert.rejects(api.savePackage(f.db,restricted,created.id,{...f.input(),expectedVersion:created.version}),{status:403})
  await assert.rejects(api.archivePackage(f.db,restricted,created.id,{expectedVersion:created.version,idempotencyKey:randomUUID()}),{status:403})
})
test('foreign company cannot resolve a package or its historical version',async()=>{
  const f=fixture(),created=await api.savePackage(f.db,f.scope,null,f.input())
  await api.activatePackageVersion(f.db,f.scope,created.id,{expectedVersion:created.version,idempotencyKey:randomUUID()})
  const foreign={...f.scope,companyId:id(500)}
  await assert.rejects(api.getPackage(f.db,foreign,created.id),{status:404})
  await assert.rejects(api.loadPackageVersion(f.db,foreign,created.id,1,{forNewSelection:false}),{status:404})
})
test('read permission cannot edit and no permission or consolidated scope grants implicit writes',async()=>{
  const f=fixture(),input=f.input()
  await assert.rejects(api.savePackage(f.db,{...f.scope,permissions:['products.view']},null,input),{status:403})
  await assert.rejects(api.listPackages(f.db,{...f.scope,permissions:[]},{}),{status:403})
  await assert.rejects(api.savePackage(f.db,{...f.scope,branchId:null},null,input),{status:400})
  await assert.rejects(api.savePackage(f.db,{...f.scope,companyId:null,isAdmin:true},null,input),{status:403})
  await assert.rejects(api.savePackage(f.db,{...f.scope,actorId:null},null,input),{status:403})
})
test('foreign or unassigned branch is not accepted even if supplied with a valid product',async()=>{
  const f=fixture(),input=f.input();input.branchIds=[id(999)]
  await assert.rejects(api.savePackage(f.db,f.scope,null,input),{status:403})
  f.scope.branchIds.push(id(999));await assert.rejects(api.savePackage(f.db,f.scope,null,input),{status:404})
})
test('services and currency follow the company settings instead of client declarations',async()=>{
  const f=fixture();f.state.settings.inventory_services_enabled='false'
  await assert.rejects(api.savePackage(f.db,f.scope,null,f.input()),{status:403})
  f.state.settings.inventory_services_enabled='true';const input=f.input();input.definition.currency='USD'
  await assert.rejects(api.savePackage(f.db,f.scope,null,input),{code:'CURRENCY_MISMATCH'})
})
