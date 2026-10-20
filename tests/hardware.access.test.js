const test=require('node:test'),assert=require('node:assert/strict')
const {harness,station}=require('./helpers/hardwareHarness.cjs'),s=require('../src/modules/config/hardware/service')
test('view permission never grants manage; consolidated cannot mutate',async()=>{
  const h=harness(),read={...h.scope,permissions:['hardware.view']}
  assert.equal((await s.workspace(h.db,read,{})).totalItems,0)
  await assert.rejects(s.saveWorkstation(h.db,read,null,station()),e=>e.status===403)
  await assert.rejects(s.workspace(h.db,{...read,permissions:[]},{}),e=>e.status===403)
  await assert.rejects(s.saveWorkstation(h.db,{...h.scope,branchId:null,isConsolidated:true},null,station()),e=>e.status===400)
  assert.equal(h.rows('hardwareAuditEvent').length,0)
})
test('hardware.manage without settings.manage may manage only hardware',async()=>{
  const h=harness();h.scope.permissions=['hardware.view','hardware.manage']
  assert.equal((await s.saveWorkstation(h.db,h.scope,null,station())).name,'PC1')
})
