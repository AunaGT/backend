require('../src/config/loadEnv')
const test=require('node:test'),assert=require('node:assert/strict')
const {withRolesDevFixture,devDbEnabled}=require('./helpers/rolesDevFixture.cjs')
const roles=require('../src/modules/users/roles/service'),{resolveVisibleRole}=require('../src/modules/users/roles/policy'),{ensureSystemAdmin}=require('../src/modules/users/roles/seed')
const {effectiveUser}=require('../src/services/userAccess')
const {readRoleSnapshot,applyRoleNormalization,snapshotHash}=require('../src/modules/users/roles/normalization')
test('Supabase: tenant isolation, generated names, revision, removed permission and assignment/delete race',{skip:!devDbEnabled},async()=>withRolesDevFixture(async f=>{
 const {db,req,roleA,roleB}=f,beforeB=await db.role.findUnique({where:{id:roleB},include:{permissions:true}})
 const rollback=Symbol('normalization-proof-rollback')
 await assert.rejects(db.$transaction(async tx=>{
  const before=await readRoleSnapshot(tx),result=await applyRoleNormalization(tx,before)
  assert.equal(result.plan.copies.length,0);assert.equal(snapshotHash(result.after),snapshotHash(before));throw rollback
 },{timeout:60000,maxWait:5000}),e=>e===rollback)
 assert.equal((await resolveVisibleRole(db,f.companyA,20)).id,roleA)
 const saved=await roles.saveRole(db,req,roleA,{name:f.marker,description:null,permissions:['products.view'],expectedRevision:0})
 assert.equal(saved.id,roleA);assert.equal(saved.revision,1);assert.deepEqual(await db.role.findUnique({where:{id:roleB},include:{permissions:true}}),beforeB)
 await assert.rejects(roles.saveRole(db,req,roleA,{name:f.marker,permissions:[],expectedRevision:0}),e=>e.code==='STALE_ROLE')
 await assert.rejects(roles.saveRole(db,req,null,{name:` ${f.marker.toUpperCase()} `,permissions:[]}),e=>e.code==='ROLE_NAME_EXISTS')
 const renamed=await roles.saveRole(db,req,roleA,{name:`${f.marker}-edit`,permissions:[],expectedRevision:1})
 assert.equal(renamed.revision,2);assert.equal((await db.role.findUnique({where:{id:roleA}})).name_key,`${f.marker.toLowerCase()}-edit`)
 const admin=await ensureSystemAdmin(db);assert.equal((await ensureSystemAdmin(db)).id,admin.id)
 await assert.rejects(roles.deleteRole(db,req,admin.id,{expectedRevision:admin.revision}),e=>e.code==='PROTECTED_ROLE')
 await assert.rejects(roles.getRole(db,req,roleB),e=>e.status===404)
 await assert.rejects(roles.resolveAssignableRole(db,req,roleB),e=>e.status===400)
 const racing=await Promise.allSettled([
  db.$transaction(async tx=>{await roles.lockRoleCompany(tx,f.companyA);const role=await roles.resolveAssignableRole(tx,req,roleA);await tx.userCompany.update({where:{user_id_company_id:{user_id:f.targetId,company_id:f.companyA}},data:{role_id:role.id}})},{timeout:30000,maxWait:5000}),
  roles.deleteRole(db,req,roleA,{expectedRevision:2}),
 ])
 assert.equal(racing.filter(r=>r.status==='fulfilled').length,1)
 const member=await db.userCompany.findUnique({where:{user_id_company_id:{user_id:f.targetId,company_id:f.companyA}},include:{role:{include:{permissions:{include:{permission:true}}}}}})
 if(racing[0].status==='fulfilled') {
  assert.equal(racing[1].reason.code,'ROLE_IN_USE');assert.equal(member.role_id,roleA)
  assert.deepEqual(effectiveUser({id:f.targetId,role:admin,user_companies:[member]},f.companyA).permissions,[])
  await db.$transaction(async tx=>{await roles.lockRoleCompany(tx,f.companyA);await tx.userCompany.update({where:{user_id_company_id:{user_id:f.targetId,company_id:f.companyA}},data:{role_id:admin.id}})})
  await roles.deleteRole(db,req,roleA,{expectedRevision:2})
 }else {assert.equal(member.role_id,admin.id);assert.equal(await db.role.findUnique({where:{id:roleA}}),null)}
 const dangling=await db.$queryRaw`SELECT count(*)::int AS count FROM user_companies m LEFT JOIN roles r ON r.id=m.role_id WHERE m.user_id=${f.targetId}::uuid AND m.role_id IS NOT NULL AND r.id IS NULL`
 assert.equal(dangling[0].count,0)
 assert.equal(await resolveVisibleRole(db,f.companyA,20),null)
 await assert.rejects(db.role.create({data:{name:' admin ',company_id:f.companyA}}))
 assert.equal(await resolveVisibleRole(db,f.companyA,987654321),null)
}))
