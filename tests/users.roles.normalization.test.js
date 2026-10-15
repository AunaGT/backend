const test=require('node:test'),assert=require('node:assert/strict')
const {roleNormalizationFixture}=require('./helpers/roleNormalizationFixture.cjs')
let api={};try{api=require('../src/modules/users/roles/normalization')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('inherited Bodega becomes local without changing the explicit B role',()=>{
 assert.equal(typeof api.planRoleNormalization,'function')
 const f=roleNormalizationFixture(), original=structuredClone(f),p=api.planRoleNormalization(f)
 assert.deepEqual(p.copies,[{sourceId:61,companyId:'company-a',name:'Bodega',description:null,permissionIds:[11]}])
 assert.deepEqual(p.membershipChanges,[{userId:'user-a',companyId:'company-a',sourceId:61}]);assert.deepEqual(p.conflicts,[]);assert.deepEqual(f,original)
})
test('shared roles copied only where used, ambiguous admins fail closed',()=>{
 assert.equal(typeof api.planRoleNormalization,'function')
 const f=roleNormalizationFixture({shared:true,adminAlias:true}),p=api.planRoleNormalization(f)
 assert.equal(p.canonicalAdminId,73);assert.deepEqual(p.adminAliasIds,[67]);assert.equal(p.copies.length,2)
 f.roles.push({id:99,name:' admin ',company_id:null,permissions:[]})
 assert.ok(api.planRoleNormalization(f).conflicts.length)
})
test('normalization reports orphan globals, conflicting local names and foreign roles',()=>{
 assert.equal(typeof api.planRoleNormalization,'function')
 const f=roleNormalizationFixture();f.roles.push({id:98,name:'Unused',company_id:null,permissions:[]})
 assert.ok(api.planRoleNormalization(f).unresolved.some(r=>r.roleId===98))
 f.roles.push({id:99,name:' bodega ',company_id:'company-a',permissions:[]})
 assert.ok(api.planRoleNormalization(f).conflicts.length)
 f.memberships[0].role_id=88;assert.ok(api.planRoleNormalization(f).conflicts.length)
})
