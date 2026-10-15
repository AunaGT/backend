const test=require('node:test'),assert=require('node:assert/strict')
let policy={};try{policy=require('../src/modules/users/roles/policy')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('admin is protected by identity, not ID or editable name',()=>{
 assert.equal(typeof policy.isSystemAdmin,'function')
 assert.equal(policy.isSystemAdmin({id:73,name:'admin',company_id:null,system_key:'ADMIN'}),true)
 for(const role of [{id:1,name:'Bodega',company_id:null},{id:9,name:'admin',company_id:'other',system_key:'ADMIN'},{name:'Admin',company_id:null}]) assert.equal(policy.isSystemAdmin(role),false)
})
test('role payload rejects reserved identities, malformed revisions and extra fields',()=>{
 assert.equal(typeof policy.parseRoleSave,'function')
 for(const raw of [{name:' admin ',permissions:[]},{name:'Bodega',permissions:[],system_key:'ADMIN'},{name:'Bodega',permissions:[],expectedRevision:-1}])assert.throws(()=>policy.parseRoleSave(raw,{creating:true}),e=>e.status===400)
 assert.throws(()=>policy.parseRoleDelete({}),e=>e.status===428)
 assert.deepEqual(policy.parseRoleSave({name:' Bodega ',permissions:['products.view','products.view'],expectedRevision:0}),{name:'Bodega',description:null,permissions:['products.view'],expectedRevision:0})
 assert.deepEqual(policy.visibleRolesWhere('a'),{OR:[{company_id:'a'},{company_id:null,system_key:'ADMIN'}]})
})
