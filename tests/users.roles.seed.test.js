const test=require('node:test'),assert=require('node:assert/strict')
let seed={};try{seed=require('../src/modules/users/roles/seed')}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('roles seed repeated creates exactly one canonical admin without assignments',async()=>{
 assert.equal(typeof seed.ensureSystemAdmin,'function')
 const roles=[],db={role:{findMany:async()=>roles,upsert:async({where,create})=>{
  let role=roles.find(r=>r.system_key===where.system_key);if(!role){role={id:73,...create};roles.push(role)}return role
 }}}
 assert.equal((await seed.ensureSystemAdmin(db)).id,73);assert.equal((await seed.ensureSystemAdmin(db)).id,73);assert.equal(roles.length,1)
})
test('seed refuses to silently duplicate an existing legacy admin',async()=>{
 assert.equal(typeof seed.ensureSystemAdmin,'function')
 const db={role:{findMany:async()=>[{id:67,name:'Admin',company_id:null,system_key:null}]}}
 await assert.rejects(seed.ensureSystemAdmin(db),/normaliz/i)
})
