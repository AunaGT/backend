const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs')
const resolve=(...args)=>require('../src/modules/config/hardware/operations').resolveWorkstation(...args)
async function fixture(){
  const h=harness();h.scope.permissions=['sales.create']
  h.station=await h.db.hardwareWorkstation.create({data:{company_id:ids.company,branch_id:ids.branch,cash_register_id:ids.register,name:'Mostrador',state:'ACTIVE'}})
  h.printer=await h.db.hardwareDevice.create({data:{company_id:ids.company,branch_id:ids.branch,name:'Tickets',kind:'RECEIPT_PRINTER',state:'ACTIVE',profile:{widthMm:80}}})
  await h.db.hardwareAssignment.create({data:{company_id:ids.company,branch_id:ids.branch,workstation_id:h.station.id,device_id:h.printer.id,role:'RECEIPT'}})
  return h
}
test('cashier without hardware administration resolves only the current register destination',async()=>{
  const h=await fixture(),dto=await resolve(h.db,h.scope,{purpose:'RECEIPT',cashRegisterId:ids.register})
  assert.equal(dto.workstationId,h.station.id);assert.equal(dto.destination.id,h.printer.id)
  assert.deepEqual(Object.keys(dto).sort(),['cashRegisterId','destination','version','workstationId'])
  assert.equal(dto.destination.profile.widthMm,80);assert.equal(dto.devices,undefined)
})
test('missing/disabled/wrong register never silently selects another station',async()=>{
  const h=await fixture()
  assert.equal(await resolve(h.db,h.scope,{purpose:'RECEIPT',workstationId:randomUUID(),cashRegisterId:ids.register}),null)
  assert.equal(await resolve(h.db,h.scope,{purpose:'RECEIPT',workstationId:h.station.id,cashRegisterId:randomUUID()}),null)
  await h.db.hardwareDevice.updateMany({where:{id:h.printer.id},data:{state:'DISABLED'}})
  assert.equal((await resolve(h.db,h.scope,{purpose:'RECEIPT',workstationId:h.station.id})).destination,null)
  await h.db.hardwareWorkstation.updateMany({where:{id:h.station.id},data:{state:'DISABLED'}})
  assert.equal(await resolve(h.db,h.scope,{purpose:'RECEIPT',workstationId:h.station.id}),null)
})
test('tenant, consolidated and revoked origin permission fail before exposing configuration',async()=>{
  const h=await fixture()
  for(const scope of [{...h.scope,branchId:null},{...h.scope,companyId:null},{...h.scope,permissions:[]}])await assert.rejects(resolve(h.db,scope,{purpose:'RECEIPT',cashRegisterId:ids.register}),e=>[400,403].includes(e.status))
  assert.equal(await resolve(h.db,{...h.scope,companyId:randomUUID()},{purpose:'RECEIPT',workstationId:h.station.id}),null)
  await assert.rejects(resolve(h.db,h.scope,{purpose:'LABEL',workstationId:h.station.id}),e=>e.status===403)
})
