const test=require('node:test'),assert=require('node:assert/strict'),{roleServiceFixture}=require('./helpers/roleServiceFixture.cjs')
const service=require('../src/modules/users/roles/service'),access=require('../src/services/userAccess')
test('an admin-like name cannot bypass grant checks without DB system identity',()=>{
 assert.throws(()=>access.assertGrant({role:{name:'admin',company_id:'a'},permissions:[]},{permissions:[{code:'users.create'}]}),e=>e.status===403)
})
test('assignment accepts only canonical admin or roles of active company',async()=>{
 const f=roleServiceFixture()
 await assert.rejects(service.resolveAssignableRole(f.db,f.req,102),e=>e.status===400)
 assert.equal((await service.resolveAssignableRole(f.db,f.req,101)).id,101)
 f.memberships[0].role_id=101;f.rows().find(r=>r.id===101).permissions=[{permission:{code:'users.edit'}}]
 await assert.rejects(service.resolveAssignableRole(f.db,f.req,73),e=>e.status===403)
})
test('explicit reassignment frees fallback without changing a second company role',async()=>{
 assert.equal(typeof service.releaseRoleFallback,'function')
 const user={id:'u',role_id:101},members=[{user_id:'u',company_id:'a',role_id:101},{user_id:'u',company_id:'b',role_id:102},{user_id:'u',company_id:'c',role_id:null}]
 const tx={$queryRaw:async()=>[{...user}],userCompany:{updateMany:async({where,data})=>{for(const m of members)if(m.user_id===where.user_id&&m.role_id===null&&m.company_id!==where.company_id.not)Object.assign(m,data)}},user:{update:async({data})=>Object.assign(user,data)}}
 await service.releaseRoleFallback(tx,user,'a',{id:101},{id:103})
 assert.equal(user.role_id,103);assert.equal(members[1].role_id,102);assert.equal(members[2].role_id,101)
})
