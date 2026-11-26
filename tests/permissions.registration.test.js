const test=require('node:test'),assert=require('node:assert/strict')
const catalog=require('../src/config/permissionCatalog')
const {expandPermissions}=require('../src/config/permissionDeps')
test('registering the catalog grants every permission only to the canonical global admin, idempotently',async()=>{
  const permissions=[],grants=[],db={permission:{
    upsert:async({create})=>{let row=permissions.find(p=>p.code===create.code);if(!row){row={id:permissions.length+1,...create};permissions.push(row)}return row},
    findMany:async()=>permissions,
  },role:{findUnique:async()=>({id:1,name:'admin',system_key:'ADMIN',company_id:null})},rolePermission:{createMany:async({data})=>{for(const g of data)if(!grants.some(x=>x.role_id===g.role_id&&x.permission_id===g.permission_id))grants.push(g)}}}
  db.$transaction=async fn=>fn(db)
  assert.equal(typeof catalog.registerPermissionsForAdmin,'function')
  await catalog.registerPermissionsForAdmin(db);await catalog.registerPermissionsForAdmin(db)
  for(const code of ['receivables.cancel_payment','merchandise.cancel_payment','merchandise.correct_payment','returns.approve','returns.complete','returns.override_policy','products.packages.publish','products.packages.archive']){
    const permission=permissions.find(p=>p.code===code);assert.ok(permission,code)
    assert.ok(grants.some(g=>g.permission_id===permission.id&&g.role_id===1))
  }
  assert.equal(grants.length,permissions.length)
  for(const code of ['products.view_costs','reports.financial'])assert.ok(permissions.some(p=>p.code===code)&&grants.some(g=>g.permission_id===permissions.find(p=>p.code===code).id&&g.role_id===1),code)
  assert.deepEqual([...new Set(grants.map(g=>g.role_id))],[1])
})
test('targeted registration refuses a legacy alias or tenant admin before changing anything',async()=>{
  for(const role of [null,{id:67,name:'Admin',system_key:null,company_id:null},{id:4,name:'admin',system_key:'ADMIN',company_id:'A'}]){
    let writes=0;const db={role:{findUnique:async()=>role},permission:{upsert:async()=>{writes++}}};db.$transaction=async fn=>fn(db)
    assert.equal(typeof catalog.registerPermissionsForAdmin,'function')
    await assert.rejects(catalog.registerPermissionsForAdmin(db),/admin/i);assert.equal(writes,0)
  }
})
test('broad operational permissions never expand to new sensitive authorities',()=>{
  const expanded=expandPermissions(['receivables.manage','merchandise.mark_paid','returns.manage','products.edit'])
  for(const code of ['products.view_costs','reports.financial'])assert.equal(expanded.includes(code),false)
  for(const code of ['receivables.cancel_payment','merchandise.cancel_payment','merchandise.correct_payment','returns.approve','returns.complete','returns.override_policy','products.packages.publish','products.packages.archive'])assert.equal(expanded.includes(code),false,code)
})
