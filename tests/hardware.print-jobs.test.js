const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs')
const service=()=>require('../src/modules/config/hardware/printing/service')
async function fixture(){const h=harness();h.scope.permissions=['sales.create'];h.sale=await h.db.sale.create({data:{branch_id:ids.branch,branch:{company_id:ids.company},created_by:ids.actor,total:'20.00',sale_items:[{item_name:'Café',qty:'2',price:'10'}]}});return h}
const input=h=>({requestKey:randomUUID(),source:{kind:'SALE_TICKET',id:h.sale.id},document:'MAIN'})
test('same request is recoverable; different payload conflicts; source snapshot stays frozen',async()=>{
 const h=await fixture(),body=input(h),a=await service().createJob(h.db,h.scope,body)
 assert.equal((await service().createJob(h.db,h.scope,body)).id,a.id)
 await assert.rejects(service().createJob(h.db,h.scope,{...body,document:'GUIDE'}),e=>e.status===409)
 await h.db.sale.updateMany({where:{id:h.sale.id},data:{total:'99'}})
 const snap=await service().jobDocument(h.db,h.scope,a.id);assert.equal(snap.sale.total,'20.00')
 assert.equal(h.rows('hardwarePrintJob').length,1);assert.equal(a.snapshot,undefined)
})
test('job/event inputs reject commands, dishonest outcomes and page subsets before mutation',async()=>{
 const h=await fixture()
 for(const extra of [{raw:'pulse'},{copies:2},{pages:[1]},{snapshot:{}},{url:'http://127.0.0.1'}])await assert.rejects(service().createJob(h.db,h.scope,{...input(h),...extra}),e=>e.status===400)
 const job=await service().createJob(h.db,h.scope,input(h))
 await assert.rejects(service().recordEvent(h.db,h.scope,job.id,{requestKey:randomUUID(),event:'PRINTED'}),e=>e.status===400)
 const event={requestKey:randomUUID(),event:'PREPARED'}
 await service().recordEvent(h.db,h.scope,job.id,event);await service().recordEvent(h.db,h.scope,job.id,event)
 assert.equal(h.rows('hardwarePrintEvent').length,1)
 await service().recordEvent(h.db,h.scope,job.id,{requestKey:randomUUID(),event:'FAILED',errorCode:'RENDER_FAILED'})
 await assert.rejects(service().recordEvent(h.db,h.scope,job.id,{requestKey:randomUUID(),event:'DOWNLOAD_REQUESTED'}),e=>e.status===409)
})
test('reprint is an explicit child using original snapshot and never changes a sale',async()=>{
 const h=await fixture(),job=await service().createJob(h.db,h.scope,input(h));await h.db.sale.updateMany({where:{id:h.sale.id},data:{total:'70'}})
 const child=await service().reprintJob(h.db,h.scope,job.id,{requestKey:randomUUID(),reason:'Se dañó la copia'})
 assert.equal(child.parentId,job.id);assert.equal((await service().jobDocument(h.db,h.scope,child.id)).sale.total,'20.00')
 assert.equal(h.rows('sale')[0].total,'70');assert.equal(h.rows('hardwareTestRun').length,0)
})
test('permission/actor/tenant are rechecked for document and event retrieval',async()=>{
 const h=await fixture(),job=await service().createJob(h.db,h.scope,input(h))
 for(const scope of [{...h.scope,actorId:randomUUID()},{...h.scope,branchId:randomUUID()},{...h.scope,companyId:randomUUID()}])await assert.rejects(service().jobDocument(h.db,scope,job.id),e=>e.status===404)
 await assert.rejects(service().jobDocument(h.db,{...h.scope,permissions:[]},job.id),e=>e.status===403)
})
test('a frozen copy can explicitly discard a revoked destination without reloading sale data',async()=>{
 const h=await fixture(),job=await service().createJob(h.db,h.scope,input(h))
 await h.db.hardwarePrintJob.updateMany({where:{id:job.id},data:{workstation_id:randomUUID(),route_snapshot:{destination:{id:randomUUID(),name:'Retirada'}}}})
 await h.db.sale.updateMany({where:{id:h.sale.id},data:{total:'99'}})
 const child=await service().reprintJob(h.db,h.scope,job.id,{requestKey:randomUUID(),reason:'PDF sin equipo retirado',pdfOnly:true})
 assert.equal(child.workstationId,null);assert.equal(child.destinationName,null);assert.equal((await service().jobDocument(h.db,h.scope,child.id)).sale.total,'20.00')
})
module.exports={fixture,input}
