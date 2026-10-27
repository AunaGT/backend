const test=require('node:test'),assert=require('node:assert/strict')
const {fixture}=require('./helpers/packagesDb'),{id}=require('./helpers/packageFixtures')
const {listPackages}=require('../src/modules/inventory/packages/catalog')
function catalog(){
 const f=fixture();let next=400
 const add=(active,archived,company=f.scope.companyId,branches=[f.scope.branchId],name='Fiesta')=>{
  const packageId=id(next++);f.state.packages.push({id:packageId,company_id:company,name,version:1,active_version:active,archived_at:archived?new Date('2026-01-01'):null})
  f.state.branches.push(...branches.map(branch_id=>({package_id:packageId,company_id:company,branch_id})))
 }
 for(let i=0;i<4;i++)add(1,false)
 for(let i=0;i<3;i++)add(null,false)
 add(1,true);add(null,true)
 add(2,false,f.scope.companyId,[f.scope.branchId,id(203)])
 add(1,false,id(999));add(1,false,f.scope.companyId,[id(203)]);add(1,false,f.scope.companyId,[f.scope.branchId],'Otro nombre')
 return f
}
test('package metrics count all matching scoped packages, not just a cursor page or shared-branch duplicates',async()=>{
 const f=catalog(),query={q:'Fiesta',limit:'1',includeSummary:'true'}
 const first=await listPackages(f.db,f.scope,query)
 assert.deepEqual(first.summary,{total:10,active:5,draft:3,archived:2});assert.equal(first.items.length,1)
 const second=await listPackages(f.db,f.scope,{...query,cursor:first.nextCursor})
 assert.deepEqual(second.summary,first.summary);assert.equal(second.items.length,1)
 const archived=await listPackages(f.db,f.scope,{...query,includeArchived:'true'})
 assert.deepEqual(archived.summary,first.summary,'Showing archived packages changes visibility, not the catalog status totals')
 const empty=await listPackages(f.db,f.scope,{...query,q:'Nada aquí'})
 assert.deepEqual(empty.summary,{total:0,active:0,draft:0,archived:0})
})
test('quote package pickers skip counts unless explicitly requested and invalid summary flags fail closed',async()=>{
 const f=catalog();f.db.commercialPackage.count=()=>{throw Error('Unneeded aggregate')}
 const list=await listPackages(f.db,f.scope,{activeOnly:'true'})
 assert.equal(Object.hasOwn(list,'summary'),false);assert.ok(list.items.length)
 await assert.rejects(listPackages(f.db,f.scope,{includeSummary:'maybe'}),{status:400})
 await assert.rejects(listPackages(f.db,{...f.scope,permissions:[]},{includeSummary:'true'}),{status:403})
})
