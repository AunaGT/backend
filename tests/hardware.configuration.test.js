const test=require('node:test'),assert=require('node:assert/strict')
const {harness,ids,station,device}=require('./helpers/hardwareHarness.cjs')
const s=require('../src/modules/config/hardware/service')
test('station writes normalize, audit atomically and reject stale edits',async()=>{
  const h=harness(),row=await s.saveWorkstation(h.db,h.scope,null,station())
  assert.equal(row.version,1);assert.equal(h.rows('hardwareAuditEvent').length,1)
  await assert.rejects(s.saveWorkstation(h.db,h.scope,row.id,{...station(),expectedVersion:2}),e=>e.status===409)
  assert.equal(h.rows('hardwareAuditEvent').length,1)
  const updated=await s.saveWorkstation(h.db,h.scope,row.id,{...station(),name:'Nuevo',expectedVersion:1})
  assert.equal(updated.version,2)
})
test('foreign company or branch identifiers cannot be read, edited or assigned',async()=>{
  const h=harness(),row=await s.saveWorkstation(h.db,h.scope,null,station()),dev=await s.saveDevice(h.db,h.scope,null,device())
  for(const scope of [{...h.scope,companyId:ids.actor},{...h.scope,branchId:ids.actor}]){
    await assert.rejects(s.saveWorkstation(h.db,scope,row.id,{...station(),expectedVersion:1}),e=>e.status===404)
    assert.equal((await s.workspace(h.db,scope,{})).workstations.length,0)
    assert.equal((await s.workspace(h.db,scope,{})).registers.length,0)
  }
  h.rows('hardwareDevice')[0].company_id=ids.actor
  await assert.rejects(s.assignDevices(h.db,h.scope,row.id,{expectedVersion:1,assignments:[{role:'SCANNER',deviceId:dev.id}]}),e=>e.status===404)
})
test('concurrent activation allows one primary workstation and rejects disabled registers',async()=>{
  const h=harness(),result=await Promise.allSettled(['PC1','PC2'].map(code=>s.saveWorkstation(h.db,h.scope,null,station(code))))
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.status,409)
  h.rows('cashRegister')[0].active=false
  await assert.rejects(s.saveWorkstation(h.db,h.scope,null,station('PC3')),e=>e.status===400)
})
test('drawer requires register and assigned matching receipt printer; disabling parent rejects',async()=>{
  const h=harness(),w=await s.saveWorkstation(h.db,h.scope,null,station()),p=await s.saveDevice(h.db,h.scope,null,device('RECEIPT_PRINTER')),
    d=await s.saveDevice(h.db,h.scope,null,device('CASH_DRAWER',{parentPrinterId:p.id}))
  await assert.rejects(s.assignDevices(h.db,h.scope,w.id,{expectedVersion:1,assignments:[{role:'DRAWER',deviceId:d.id}]}),e=>e.status===400)
  const next=await s.assignDevices(h.db,h.scope,w.id,{expectedVersion:1,assignments:[{role:'DRAWER',deviceId:d.id},{role:'RECEIPT',deviceId:p.id}]})
  assert.equal(next.version,2)
  await assert.rejects(s.saveDevice(h.db,h.scope,p.id,{...device('RECEIPT_PRINTER'),state:'DISABLED',expectedVersion:1}),e=>e.status===409)
})
test('open session blocks changing register, state, assignments and associated device',async()=>{
  const h=harness(),w=await s.saveWorkstation(h.db,h.scope,null,station()),d=await s.saveDevice(h.db,h.scope,null,device())
  await s.assignDevices(h.db,h.scope,w.id,{expectedVersion:1,assignments:[{role:'SCANNER',deviceId:d.id}]})
  h.rows('cashRegisterSession').push({cash_register_id:ids.register,status:'OPEN'})
  for(const action of [()=>s.saveWorkstation(h.db,h.scope,w.id,{...station(),state:'DISABLED',expectedVersion:2}),()=>s.assignDevices(h.db,h.scope,w.id,{expectedVersion:2,assignments:[]}),()=>s.saveDevice(h.db,h.scope,d.id,{...device(),expectedVersion:1})])await assert.rejects(action(),e=>e.status===409)
  assert.equal(h.rows('hardwareAssignment').length,1)
})
test('query errors propagate rather than becoming an empty workspace',async()=>{
  const h=harness();h.db.hardwareDevice.findMany=async()=>{throw new Error('offline')}
  await assert.rejects(s.workspace(h.db,h.scope,{}),/offline/)
})
test('receipt printer referenced by a drawer cannot change kind even if not assigned',async()=>{
  const h=harness(),p=await s.saveDevice(h.db,h.scope,null,device('RECEIPT_PRINTER'))
  await s.saveDevice(h.db,h.scope,null,device('CASH_DRAWER',{parentPrinterId:p.id}))
  await assert.rejects(s.saveDevice(h.db,h.scope,p.id,{...device('SCANNER'),expectedVersion:1}),e=>e.status===409)
})
test('device assigned to active station cannot return to draft',async()=>{
 const h=harness(),w=await s.saveWorkstation(h.db,h.scope,null,station()),input=device(),d=await s.saveDevice(h.db,h.scope,null,input)
 await s.assignDevices(h.db,h.scope,w.id,{expectedVersion:1,assignments:[{role:'SCANNER',deviceId:d.id}]})
 await assert.rejects(s.saveDevice(h.db,h.scope,d.id,{...input,state:'DRAFT',expectedVersion:1}),e=>e.status===409)
 assert.equal(h.rows('hardwareDevice')[0].state,'ACTIVE')
})
test('one drawer cannot be assigned to two active workstations even with different registers',async()=>{
 const h=harness(),second='10000000-0000-4000-8000-000000000099';h.rows('cashRegister').push({...h.rows('cashRegister')[0],id:second})
 const w1=await s.saveWorkstation(h.db,h.scope,null,station('ONE')),w2=await s.saveWorkstation(h.db,h.scope,null,{...station('TWO'),cashRegisterId:second}),p=await s.saveDevice(h.db,h.scope,null,device('RECEIPT_PRINTER')),d=await s.saveDevice(h.db,h.scope,null,device('CASH_DRAWER',{parentPrinterId:p.id})),assignments=[{role:'DRAWER',deviceId:d.id},{role:'RECEIPT',deviceId:p.id}]
 await s.assignDevices(h.db,h.scope,w1.id,{expectedVersion:1,assignments})
 await assert.rejects(s.assignDevices(h.db,h.scope,w2.id,{expectedVersion:1,assignments}),e=>e.status===409)
 assert.equal(h.rows('hardwareAssignment').length,2)
})
test('activating a draft station rechecks shared drawer exclusivity',async()=>{
 const h=harness(),second='10000000-0000-4000-8000-000000000099';h.rows('cashRegister').push({...h.rows('cashRegister')[0],id:second})
 const w1=await s.saveWorkstation(h.db,h.scope,null,station('ONE')),w2=await s.saveWorkstation(h.db,h.scope,null,{...station('TWO'),cashRegisterId:second,state:'DRAFT'}),p=await s.saveDevice(h.db,h.scope,null,device('RECEIPT_PRINTER')),d=await s.saveDevice(h.db,h.scope,null,device('CASH_DRAWER',{parentPrinterId:p.id})),assignments=[{role:'DRAWER',deviceId:d.id},{role:'RECEIPT',deviceId:p.id}]
 await s.assignDevices(h.db,h.scope,w1.id,{expectedVersion:1,assignments});await s.assignDevices(h.db,h.scope,w2.id,{expectedVersion:1,assignments})
 await assert.rejects(s.saveWorkstation(h.db,h.scope,w2.id,{...station('TWO'),cashRegisterId:second,expectedVersion:2}),e=>e.status===409)
})
