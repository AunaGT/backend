const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const access = () => require('../src/modules/cash-closure/corrections.access')
const logic = () => require('../src/modules/cash-closure/corrections')
const req = permissions => ({ companyId:randomUUID(),branchId:randomUUID(),user:{sub:randomUUID(),permissions,role:{name:'admin'}} })
test('correction authority separates proposing, deciding and parent read access', () => {
  const s = access().correctionScope(req(['cashclosure.correct']),'propose')
  assert.equal(s.canPropose,true);assert.equal(s.canReview,false);assert.equal(s.viewTeam,true)
  assert.equal(require('../src/modules/cash-closure/readAccess').readCapabilities(req(['cashclosure.correct'])).viewTeam,true)
  assert.throws(()=>access().correctionScope(req(['cashclosure.correct']),'review'),e=>e.status===403)
  assert.throws(()=>access().correctionScope(req(['cashclosure.approve']),'propose'),e=>e.status===403)
  assert.equal(access().correctionScope(req(['cashclosure.approve']),'review').canReview,true)
  assert.equal(access().correctionScope(req(['cashclosure.view']),'read').viewTeam,false)
  assert.throws(()=>access().correctionScope(req([]),'read'),e=>e.status===403)
})
test('integration credentials, missing concrete scope and forged admin cannot correct', () => {
  for(const patch of [{integrationCredential:{}},{branchId:'all'},{companyId:null},{user:{sub:randomUUID(),role:{name:'admin'},permissions:[]}}])
    assert.throws(()=>access().correctionScope({...req(['cashclosure.correct']),...patch},'propose'))
})
test('authorized consolidated readers inherit parent access but cannot propose, approve or cancel',()=>{
  const r={...req(['cashclosure.view_team','cashclosure.correct','cashclosure.approve']),branchId:null,branchIds:[randomUUID(),randomUUID()]}
  const s=access().correctionScope(r,'read')
  assert.equal(s.viewTeam,true);assert.deepEqual(s.branchIds,r.branchIds);assert.equal(s.canPropose,false);assert.equal(s.canReview,false)
  assert.throws(()=>access().correctionScope(r,'propose'),e=>e.status===403)
})
const original = () => ({id:randomUUID(),currency:'GTQ',previousCorrectionId:null,lines:[{closurePaymentId:1,paymentMethodId:2,name:'Efectivo',kind:'CASH',originalExpected:'1000.00',previousActual:'900.00'},{closurePaymentId:2,paymentMethodId:2,name:'Transferencia',kind:'BANK',originalExpected:'50.00',previousActual:'50.00'}]})
const input = base => ({reason:'Corrección del conteo documentado',accountingDate:'2026-11-20',previousCorrectionId:base.previousCorrectionId,lines:[{closurePaymentId:1,correctedActual:'980.00'},{closurePaymentId:2,correctedActual:'50.00'}]})
test('successive corrections compute exact deltas against the last approved actual', () => {
  const base=original(),a=logic().calculateCorrection(base,input(base))
  assert.equal(a.cashDelta,'80.00');assert.equal(a.correctedDifference,'-20.00')
  base.lines[0].previousActual='980.00';base.previousCorrectionId=randomUUID()
  const b=input(base);b.lines[0].correctedActual='970.00'
  assert.equal(logic().calculateCorrection(base,b).cashDelta,'-10.00')
  assert.equal(logic().calculateCorrection(base,b).correctedDifference,'-30.00')
})
test('correction validation rejects missing, duplicated, forged, negative or excessive precision lines', () => {
  for(const mutate of [b=>b.lines.pop(),b=>b.lines[1].closurePaymentId=1,b=>b.lines[0].correctedActual='1e3',b=>b.lines[0].correctedActual='-1',b=>b.lines[0].correctedActual='9.001',b=>b.lines[0].delta='80',b=>b.accountingDate='2026-02-30',b=>b.reason='',b=>b.accountId=4,b=>b.previousCorrectionId=randomUUID()]){
    const base=original(),b=input(base);mutate(b);assert.throws(()=>logic().calculateCorrection(base,b))
  }
})
test('unchanged declarations fail and digital deltas never become cash', () => {
  const base=original(),b=input(base);b.lines[0].correctedActual='900.00'
  assert.throws(()=>logic().calculateCorrection(base,b),e=>e.status===400)
  b.lines[1].correctedActual='75.00';assert.equal(logic().calculateCorrection(base,b).cashDelta,'0.00')
})
test('optional denominations must exactly sum corrected cash and cannot appear on virtual-only corrections', () => {
  const base=original(),b=input(base);b.denominations=[{denomination:'20',quantity:49,type:'Billete'}]
  assert.equal(logic().calculateCorrection(base,b).denominations[0].subtotal,'980.00')
  b.denominations[0].quantity=48;assert.throws(()=>logic().calculateCorrection(base,b))
  b.denominations[0].quantity=49;base.lines=base.lines.slice(1);b.lines=b.lines.slice(1);b.lines[0].correctedActual='60'
  assert.throws(()=>logic().calculateCorrection(base,b))
})
test('targeted correction registration grants only canonical admin and keeps other role grants intact',async()=>{
  const {registerCashCorrectionPermissionsForAdmin:register}=require('../scripts/register-cash-permissions')
  const rows=[],grants=[{role_id:112,permission_id:999},{role_id:139,permission_id:999}]
  const db={role:{findUnique:async()=>({id:1,name:'admin',system_key:'ADMIN',company_id:null})},permission:{upsert:async({create})=>{let row=rows.find(r=>r.code===create.code);if(!row)rows.push(row={id:rows.length+1,...create});return row}},rolePermission:{createMany:async({data})=>{for(const row of data)if(!grants.some(g=>g.role_id===row.role_id&&g.permission_id===row.permission_id))grants.push(row)}}}
  db.$transaction=fn=>fn(db);await register(db);await register(db)
  assert.equal(rows.length,1);assert.equal(rows[0].code,'cashclosure.correct')
  assert.deepEqual(grants,[{role_id:112,permission_id:999},{role_id:139,permission_id:999},{role_id:1,permission_id:1}])
  await assert.rejects(register({...db,$transaction:fn=>fn({...db,role:{findUnique:async()=>({id:2,name:'admin'})}})}),/admin/)
  const codes=require('../src/config/permissionDeps').expandPermissions(['cashclosure.correct'])
  assert.ok(codes.includes('cashclosure.view_team'));assert.equal(codes.includes('cashclosure.approve'),false)
})
