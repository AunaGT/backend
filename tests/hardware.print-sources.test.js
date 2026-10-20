const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs')
const source=()=>require('../src/modules/config/hardware/printing/sources')
test('label sources are existing owned preparations, with copies and prices unchanged',async()=>{
 const h=harness();h.scope.permissions=['products.view','products.export']
 const id=randomUUID(),snapshot={id,companyId:ids.company,actorId:ids.actor,scope:{branchId:ids.branch},products:[{id:randomUUID(),price:'7.50',copies:10}],paper:{format:'thermal',widthMm:60,heightMm:40},design:{purpose:'shelf'}}
 await h.db.barcodePrintPreparation.create({data:{id,company_id:ids.company,branch_id:ids.branch,actor_id:ids.actor,snapshot}})
 const out=await source().resolvePrintSource(h.db,h.scope,{kind:'LABEL_PREPARATION',id})
 assert.deepEqual(out.prepared,snapshot)
 await assert.rejects(source().resolvePrintSource(h.db,{...h.scope,actorId:randomUUID()},{kind:'LABEL_PREPARATION',id}),e=>e.status===404)
 await assert.rejects(source().resolvePrintSource(h.db,h.scope,{kind:'LABEL_PREPARATION',id:randomUUID()}),e=>e.status===404)
})
test('oversized snapshots are rejected without retaining arbitrary document bytes',()=>{
 assert.throws(()=>source().boundedSnapshot({content:'a'.repeat(2*1024*1024)}),e=>e.status===400)
})
test('thermal compatibility compares actual label dimensions, not the unused sheet dimensions',async()=>{
 const h=harness();h.scope.permissions=['products.view','products.export']
 const station=await h.db.hardwareWorkstation.create({data:{company_id:ids.company,branch_id:ids.branch,state:'ACTIVE'}})
 const printer=await h.db.hardwareDevice.create({data:{company_id:ids.company,branch_id:ids.branch,name:'Etiquetas',kind:'LABEL_PRINTER',state:'ACTIVE',profile:{widthMm:70,heightMm:35,copies:1}}})
 await h.db.hardwareAssignment.create({data:{company_id:ids.company,branch_id:ids.branch,workstation_id:station.id,device_id:printer.id,role:'LABEL'}})
 const id=randomUUID(),snapshot={id,companyId:ids.company,actorId:ids.actor,products:[{id:randomUUID(),price:'7',copies:10}],paper:{format:'thermal',widthMm:215.9,heightMm:279.4},design:{widthMm:70,heightMm:35}}
 await h.db.barcodePrintPreparation.create({data:{id,company_id:ids.company,branch_id:ids.branch,actor_id:ids.actor,snapshot}})
 const job=await require('../src/modules/config/hardware/printing/service').createJob(h.db,h.scope,{requestKey:randomUUID(),source:{kind:'LABEL_PREPARATION',id},document:'MAIN',workstationId:station.id,destinationId:printer.id})
 assert.equal(job.destinationName,'Etiquetas')
 await h.db.hardwareDevice.updateMany({where:{id:printer.id},data:{profile:{widthMm:60,heightMm:35}}})
 await assert.rejects(require('../src/modules/config/hardware/printing/service').createJob(h.db,h.scope,{requestKey:randomUUID(),source:{kind:'LABEL_PREPARATION',id},document:'MAIN',workstationId:station.id,destinationId:printer.id}),e=>e.status===409)
})
