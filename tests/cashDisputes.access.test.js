const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {disputeScope}=require('../src/modules/cash-closure/disputes.access')
const req=permissions=>({companyId:randomUUID(),branchId:randomUUID(),user:{sub:randomUUID(),permissions,role:{name:'admin'}}})
test('dispute recording, bank movements and customer debt approval are separate authorities',()=>{
  const manage=disputeScope(req(['cash.disputes.manage']),'manage')
  assert.equal(manage.can.read,true);assert.equal(manage.can.movements,false);assert.equal(manage.can.charge,false)
  assert.throws(()=>disputeScope(req(['cash.disputes.manage']),'resolve'),{status:403})
  assert.throws(()=>disputeScope(req(['cash.disputes.resolve']),'charge'),{status:403})
  assert.throws(()=>disputeScope(req(['cash.disputes.charge_customer']),'charge'),{status:403})
  assert.equal(disputeScope(req(['cash.disputes.resolve','cash.disputes.charge_customer']),'charge').can.charge,true)
  assert.equal(disputeScope(req(['cash.disputes.movements']),'read').can.read,true)
  assert.throws(()=>disputeScope(req(['cashclosure.approve','receivables.manage']),'movements'),{status:403})
})
test('consolidated dispute consultation does not permit commands or fake administrator bypass',()=>{
  const r={...req(['cash.disputes.view','cash.disputes.manage']),branchId:'all',branchIds:[randomUUID(),randomUUID()]}
  assert.deepEqual(disputeScope(r,'read').branchIds,r.branchIds)
  assert.equal(disputeScope(r,'read').can.manage,false)
  assert.throws(()=>disputeScope(r,'manage'),{status:403})
  assert.throws(()=>disputeScope(req([]),'resolve'),{status:403})
  for(const patch of [{integrationCredential:{}},{integration:{}},{companyId:null}])assert.throws(()=>disputeScope({...req(['cash.disputes.manage']),...patch},'read'))
})
test('canonical admin still has an explicit policy capability, not an implicit self-review permission',()=>{
  const r=req([]);r.user.role={name:'admin',system_key:'ADMIN',company_id:null}
  const s=disputeScope(r,'policy')
  assert.equal(s.isAdmin,true);assert.equal(s.can.policy,true)
  assert.equal(s.ownerSelfReview,undefined)
  assert.throws(()=>disputeScope(req(['cash.policies.manage']),'policy'),{status:403})
})
test('scope canonicalizes equivalent UUIDs before query keys and financial lock selection',()=>{
  const r=req(['cash.disputes.view'])
  r.companyId=r.companyId.toUpperCase();r.branchId=r.branchId.toUpperCase();r.user.sub=r.user.sub.toUpperCase()
  const s=disputeScope(r,'read')
  assert.equal(s.companyId,r.companyId.toLowerCase());assert.equal(s.branchId,r.branchId.toLowerCase());assert.equal(s.userId,r.user.sub.toLowerCase())
})
test('targeted dispute registration is idempotent and grants no new permissions to company roles',async()=>{
  const rows=[],grants=[{role_id:112,permission_id:999},{role_id:139,permission_id:999}]
  const db={role:{findUnique:async()=>({id:1,name:'admin',system_key:'ADMIN',company_id:null})},permission:{upsert:async({create})=>{let row=rows.find(r=>r.code===create.code);if(!row)rows.push(row={id:rows.length+1,...create});return row}},rolePermission:{createMany:async({data})=>{for(const row of data)if(!grants.some(g=>g.role_id===row.role_id&&g.permission_id===row.permission_id))grants.push(row)}}}
  db.$transaction=fn=>fn(db)
  const register=require('../scripts/register-cash-permissions').registerCashDisputePermissionsForAdmin
  await register(db);await register(db)
  assert.equal(rows.length,5);assert.equal(grants.length,7)
  assert.deepEqual(grants.filter(g=>g.role_id!==1),[{role_id:112,permission_id:999},{role_id:139,permission_id:999}])
  const expand=require('../src/config/permissionDeps').expandPermissions
  assert.ok(expand(['cash.disputes.manage']).includes('cash.disputes.view'))
  assert.equal(expand(['cash.disputes.charge_customer']).includes('cash.disputes.resolve'),false)
  assert.equal(expand(['cash.disputes.resolve']).includes('receivables.manage'),false)
})
