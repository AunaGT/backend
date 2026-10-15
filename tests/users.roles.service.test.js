const test=require('node:test'),assert=require('node:assert/strict'),{roleServiceFixture}=require('./helpers/roleServiceFixture.cjs')
let api={};try{api=require('../src/modules/users/roles/service')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
const input={name:'Bodega',description:null,permissions:['products.view'],expectedRevision:0}
test('save maintains ID and rejects stale revision without overwriting permissions',async()=>{
 assert.equal(typeof api.saveRole,'function');const f=roleServiceFixture()
 const saved=await api.saveRole(f.db,f.req,101,input);assert.equal(saved.id,101);assert.equal(saved.revision,1);assert.deepEqual(saved.permissions.map(p=>p.code),['products.view','warehouses.view'])
 await assert.rejects(api.saveRole(f.db,f.req,101,{...input,name:'Obsoleto'}),e=>e.code==='STALE_ROLE');assert.equal(f.rows().find(r=>r.id===101).name,'Bodega')
 assert.equal(f.events.length,1)
})
test('normal roles are local, admin protected, revisions and grants authoritative',async()=>{
 assert.equal(typeof api.saveRole,'function');const f=roleServiceFixture()
 await assert.rejects(api.saveRole(f.db,f.req,102,input),e=>e.status===404)
 await assert.rejects(api.saveRole(f.db,f.req,73,input),e=>e.status===403)
 await assert.rejects(api.saveRole(f.db,f.req,101,{name:'Bodega',permissions:[]}),e=>e.status===428)
 await assert.rejects(api.saveRole(f.db,f.req,101,{...input,permissions:['unknown.permission']}),e=>e.status===400)
 f.memberships[0].role_id=101;f.rows().find(r=>r.id===101).permissions=[{permission:{code:'roles.manage'}}]
 await assert.rejects(api.saveRole(f.db,f.req,101,input),e=>e.code==='OWN_ROLE')
 await assert.rejects(api.saveRole(f.db,f.req,null,{name:'Mayor',permissions:['products.view']}),e=>e.status===403)
})
test('delete checks effective users and fallback references and never reassigns users',async()=>{
 assert.equal(typeof api.deleteRole,'function');const f=roleServiceFixture()
 f.users.push({id:'inherited',role_id:101});f.memberships.push({user_id:'inherited',company_id:'a',role_id:null,status:'BLOCKED'})
 const detail=await api.getRole(f.db,f.req,101);assert.equal(detail.usersCount,1);assert.equal(detail.legacyReferenceCount,1);assert.equal(detail.canDelete,false)
 await assert.rejects(api.deleteRole(f.db,f.req,101,{expectedRevision:0}),e=>e.code==='ROLE_IN_USE')
 f.users.pop();f.memberships.pop();await api.deleteRole(f.db,f.req,101,{expectedRevision:0});assert.equal(f.rows().some(r=>r.id===101),false);assert.equal(f.users[0].role_id,73)
})
