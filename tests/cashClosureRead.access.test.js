const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const companyId = randomUUID(), branchId = randomUUID(), userId = randomUUID()
const req = permissions => ({ companyId, branchId, user: { sub: userId, permissions, role: { name: 'Cajero' } } })
test('closure reading separates own, team and operation independently of role names', () => {
  const { readCapabilities, readScope } = require('../src/modules/cash-closure/readAccess')
  assert.deepEqual(readCapabilities(req(['cashclosure.view'])), { viewOwn: true, viewTeam: false })
  assert.equal(readScope(req(['cashclosure.view'])).mode, 'mine')
  assert.throws(() => readScope(req(['cashclosure.view']), 'team'), e => e.status === 403)
  for (const code of ['cashclosure.view_team','cashclosure.approve','cashclosure.validate']) {
    assert.deepEqual(readCapabilities(req([code])), { viewOwn: true, viewTeam: true })
    assert.equal(readScope(req([code])).mode, 'team')
    assert.equal(readScope(req([code]), 'mine').mode, 'mine')
  }
  for (const code of ['sales.create','settings.manage','cash.registers.manage','cashclosure.create_day'])
    assert.throws(() => readScope(req([code])), e => e.status === 403)
  assert.throws(() => readScope(req(['cashclosure.view']), 'any'), e => e.status === 400)
  assert.throws(() => readScope({ ...req(['cashclosure.view']), integrationCredential: {} }), e => e.status === 401)
  assert.throws(() => readScope({ ...req(['cashclosure.view']), companyId: undefined }), e => e.status === 403)
  assert.equal(readCapabilities({ ...req([]), user: { ...req([]).user, role: { name: 'admin' } } }).viewTeam, false)
  assert.equal(readCapabilities({ ...req([]), user: { ...req([]).user, role: { name: 'admin', system_key:'ADMIN',company_id:null } } }).viewTeam, true)
  assert.deepEqual(readScope({ ...req(['cashclosure.view']), branchId:null, branchIds:[branchId] }).branchIds,[branchId])
})
test('targeted closure read registration is idempotent and only grants the new authority to canonical admin', async () => {
  const { registerCashClosureReadPermissionsForAdmin } = require('../scripts/register-cash-permissions')
  assert.equal(typeof registerCashClosureReadPermissionsForAdmin, 'function')
  const rows=[], grants=[{role_id:112,permission_id:999}], db={role:{findUnique:async()=>({id:1,name:'admin',system_key:'ADMIN',company_id:null})},
    permission:{upsert:async({create,update})=>{let r=rows.find(r=>r.code===create.code);if(r)Object.assign(r,update);else rows.push(r={id:rows.length+1,...create});return r}},
    rolePermission:{createMany:async({data})=>{for(const g of data)if(!grants.some(x=>x.role_id===g.role_id&&x.permission_id===g.permission_id))grants.push(g)}}}
  db.$transaction=fn=>fn(db)
  await registerCashClosureReadPermissionsForAdmin(db);await registerCashClosureReadPermissionsForAdmin(db)
  assert.equal(rows.length,2);assert.equal(rows.find(r=>r.code==='cashclosure.view').name,'Consultar mis arqueos')
  const team=rows.find(r=>r.code==='cashclosure.view_team')
  assert.deepEqual(grants.filter(g=>g.permission_id===team.id),[{role_id:1,permission_id:team.id}])
  assert.deepEqual(grants.filter(g=>g.role_id===112),[{role_id:112,permission_id:999}])
  for (const role of [null,{id:2,name:'admin'},{id:2,name:'admin',system_key:'ADMIN',company_id:companyId}]) {
    await assert.rejects(registerCashClosureReadPermissionsForAdmin({...db, $transaction:fn=>fn({...db,role:{findUnique:async()=>role}})}),/admin/i)
  }
  const {expandPermissions}=require('../src/config/permissionDeps')
  assert.ok(expandPermissions(['cashclosure.view_team']).includes('cashclosure.view'))
  for(const code of ['cashclosure.create','cashclosure.create_day','cashclosure.create_own','sales.create'])assert.ok(!expandPermissions([code]).includes('cashclosure.view_team'))
  assert.ok(!expandPermissions(['cashclosure.view_team']).includes('cashclosure.approve'))
})
