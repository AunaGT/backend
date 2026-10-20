const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,station,device}=require('./helpers/hardwareHarness.cjs'),s=require('../src/modules/config/hardware/service')
test('diagnostics are scoped, idempotent, bound to assigned device and cannot affect business data',async()=>{
  const h=harness(),w=await s.saveWorkstation(h.db,h.scope,null,station()),d=await s.saveDevice(h.db,h.scope,null,device())
  const input={requestKey:randomUUID(),workstationId:w.id,deviceId:d.id,kind:'SCAN_INPUT',mode:'BROWSER',outcome:'INPUT_RECEIVED',sampleCode:'00123'}
  await assert.rejects(s.recordTest(h.db,h.scope,input),e=>e.status===400)
  await s.assignDevices(h.db,h.scope,w.id,{expectedVersion:1,assignments:[{role:'SCANNER',deviceId:d.id}]})
  const rows=await Promise.all([s.recordTest(h.db,h.scope,input),s.recordTest(h.db,h.scope,input)])
  assert.equal(rows[0].id,rows[1].id);assert.equal(h.rows('hardwareTestRun').length,1);assert.equal(rows[0].sampleCode,'00123')
  await assert.rejects(s.recordTest(h.db,h.scope,{...input,sampleCode:'00222'}),e=>e.status===409)
  assert.equal(h.rows('cashRegisterSession').length,0)
})
test('drawer simulation requires its own permission, not printing permission and never physical outcome',async()=>{
  const h=harness(),w=await s.saveWorkstation(h.db,h.scope,null,station()),p=await s.saveDevice(h.db,h.scope,null,device('RECEIPT_PRINTER')),d=await s.saveDevice(h.db,h.scope,null,device('CASH_DRAWER',{parentPrinterId:p.id}))
  await s.assignDevices(h.db,h.scope,w.id,{expectedVersion:1,assignments:[{role:'RECEIPT',deviceId:p.id},{role:'DRAWER',deviceId:d.id}]})
  const input={requestKey:randomUUID(),workstationId:w.id,deviceId:d.id,kind:'DRAWER_SIMULATION',mode:'SIMULATED',outcome:'SIMULATED'}
  await assert.rejects(s.recordTest(h.db,{...h.scope,permissions:['hardware.view','hardware.test_print']},input),e=>e.status===403)
  const row=await s.recordTest(h.db,{...h.scope,permissions:['hardware.view','hardware.test_drawer']},input)
  assert.equal(row.outcome,'SIMULATED');assert.equal(h.rows('hardwareDevice').find(x=>x.id===d.id).state,'ACTIVE')
})
