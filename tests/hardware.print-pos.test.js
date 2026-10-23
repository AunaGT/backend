const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids,receiptSale}=require('./helpers/hardwareHarness.cjs')
const service=require('../src/modules/config/hardware/printing/service')
async function fixture(){const h=harness();h.scope.permissions=['sales.create'];const sale=await h.db.sale.create({data:receiptSale()});return{...h,input:{requestKey:randomUUID(),source:{kind:'SALE_TICKET',id:sale.id},document:'MAIN'}}}
const keys=()=>({preparedRequestKey:randomUUID(),downloadRequestKey:randomUUID()})
test('POS creation returns the authorized frozen document without changing the legacy DTO',async()=>{
 const h=await fixture(),result=await service.createJob(h.db,h.scope,h.input,{includeDocument:true})
 assert.equal(result.document.renderer,'SALE_DOCUMENT_V2');assert.equal(h.rows('documentSnapshot')[0].data.totals.total,'20.00');assert.equal(result.document.branding.jobId,result.job.id)
 assert.equal(result.document.branding.companyId,ids.company)
 await h.db.sale.updateMany({where:{id:h.input.source.id},data:{total:'99'}})
 const replay=await service.createJob(h.db,h.scope,h.input,{includeDocument:true})
 assert.equal(replay.job.id,result.job.id);assert.equal(replay.document.artifactId,result.document.artifactId);assert.equal(h.rows('documentSnapshot')[0].data.totals.total,'20.00')
 const legacy=await service.createJob(h.db,h.scope,h.input)
 assert.equal(legacy.id,result.job.id);assert.equal(legacy.document,'MAIN');assert.equal(legacy.snapshot,undefined)
 for(const scope of [{...h.scope,permissions:[]},{...h.scope,actorId:randomUUID()},{...h.scope,branchId:randomUUID()},{...h.scope,companyId:randomUUID()}])await assert.rejects(service.createJob(h.db,scope,h.input,{includeDocument:true}),e=>[403,404,409].includes(e.status))
})
test('prepared download persists two honest events atomically and repeated requests do not duplicate them',async()=>{
 const h=await fixture(),job=await service.createJob(h.db,h.scope,h.input),input=keys()
 assert.equal(typeof service.recordPreparedDownload,'function')
 const [first,replay]=await Promise.all([service.recordPreparedDownload(h.db,h.scope,job.id,input),service.recordPreparedDownload(h.db,h.scope,job.id,input)])
 assert.equal(first.state,'DOWNLOAD_REQUESTED');assert.equal(replay.id,job.id)
 assert.deepEqual(h.rows('hardwarePrintEvent').map(e=>e.event),['PREPARED','DOWNLOAD_REQUESTED'])
 await assert.rejects(service.recordPreparedDownload(h.db,h.scope,job.id,keys()),e=>e.status===409)
 for(const scope of [{...h.scope,permissions:[]},{...h.scope,actorId:randomUUID()},{...h.scope,branchId:randomUUID()}])await assert.rejects(service.recordPreparedDownload(h.db,scope,job.id,input),e=>[403,404].includes(e.status))
})
test('failed grouped event write rolls back all events and job state',async()=>{
 const h=await fixture(),job=await service.createJob(h.db,h.scope,h.input),create=h.db.hardwarePrintEvent.createMany
 h.db.hardwarePrintEvent.createMany=async args=>{await create(args);throw Error('storage unavailable')}
 assert.equal(typeof service.recordPreparedDownload,'function')
 await assert.rejects(service.recordPreparedDownload(h.db,h.scope,job.id,keys()),/storage unavailable/)
 assert.equal(h.rows('hardwarePrintEvent').length,0);assert.equal(h.rows('hardwarePrintJob')[0].state,'CREATED')
})
test('new ticket captures exact historical units without querying mutable catalog or exposing costs',async()=>{
 const h=await fixture(),read=h.db.$queryRaw;let grouped=0,separate=0
 h.db.$queryRaw=async(...args)=>{grouped++;return read(...args)}
 const old=h.db.sale.findFirst;h.db.sale.findFirst=async args=>{separate++;return old(args)}
 await h.db.sale.updateMany({where:{id:h.input.source.id},data:{sale_items:[{item_name:'Fracción histórica',unit_label:'kg',qty:'0.123456',price:'1.123456789012345678',net_total:'0.14',unit_metadata_version:2,unit_snapshot:{version:2,baseUnit:{label:'kg'},factor:'1'},base_qty:'0.123456',base_unit_cost:'SECRET',unit_cost:'SECRET'}]}})
 const result=await service.createJob(h.db,h.scope,h.input,{includeDocument:true})
 assert.equal(grouped,0);assert.ok(separate>0)
 const snapshot=h.rows('documentSnapshot')[0],line=snapshot.data.lines[0]
 assert.equal(line.price,'1.123456789012345678');assert.equal(line.quantity,'0.123456');assert.equal(line.unit,'kg');assert.equal(line.total,'0.14')
 assert.equal(JSON.stringify(snapshot.data).includes('SECRET'),false);assert.equal(result.document.renderer,'SALE_DOCUMENT_V2')
})
test('prepared download groups key reads, insertion and state change without changing its two events',async()=>{
 const h=await fixture(),job=await service.createJob(h.db,h.scope,h.input),counts={reads:0,inserts:0,changes:0}
 for(const [model,method,label]of [['hardwarePrintEvent','findMany','reads'],['hardwarePrintEvent','createMany','inserts'],['hardwarePrintJob','updateMany','changes']]){const call=h.db[model][method];h.db[model][method]=async args=>{counts[label]++;return call(args)}}
 await service.recordPreparedDownload(h.db,h.scope,job.id,keys())
 assert.deepEqual(h.rows('hardwarePrintEvent').map(e=>e.event),['PREPARED','DOWNLOAD_REQUESTED']);assert.deepEqual(counts,{reads:1,inserts:1,changes:1})
})
test('conflicting prior event keys and a failed state claim cannot partially persist a prepared download',async()=>{
 const h=await fixture(),job=await service.createJob(h.db,h.scope,h.input),input=keys()
 await service.recordEvent(h.db,h.scope,job.id,{requestKey:input.preparedRequestKey,event:'PREPARED'})
 await assert.rejects(service.recordPreparedDownload(h.db,h.scope,job.id,{...input,downloadRequestKey:input.preparedRequestKey}),e=>e.status===400)
 h.db.hardwarePrintJob.updateMany=async()=>({count:0})
 await assert.rejects(service.recordPreparedDownload(h.db,h.scope,job.id,input),e=>e.status===409)
 assert.deepEqual(h.rows('hardwarePrintEvent').map(e=>e.event),['PREPARED']);assert.equal(h.rows('hardwarePrintJob')[0].state,'PREPARED')
})
test('prepared download completes its own partial preparation but rejects injected commands or conflicting keys',async()=>{
 const h=await fixture(),job=await service.createJob(h.db,h.scope,h.input),input=keys()
 assert.equal(typeof service.recordPreparedDownload,'function')
 for(const invalid of [{...input,event:'PRINTED'},{...input,downloadRequestKey:input.preparedRequestKey},{...input,preparedRequestKey:'bad'}])await assert.rejects(service.recordPreparedDownload(h.db,h.scope,job.id,invalid),e=>e.status===400)
 await service.recordEvent(h.db,h.scope,job.id,{requestKey:input.preparedRequestKey,event:'PREPARED'})
 await service.recordPreparedDownload(h.db,h.scope,job.id,input)
 assert.equal(h.rows('hardwarePrintEvent').length,2)
})
test('document response opt-in rejects malformed query values before any print write',()=>{
 const {documentOption}=require('../src/modules/config/hardware/printing/validation')
 assert.equal(documentOption(undefined),false);assert.equal(documentOption('true'),true)
 for(const raw of ['false','TRUE',['true'],{},true])assert.throws(()=>documentOption(raw),e=>e.status===400)
})
test('prepared download never resurrects a failed render or reuses an unrelated event key',async()=>{
 const h=await fixture(),job=await service.createJob(h.db,h.scope,h.input),input=keys()
 await service.recordEvent(h.db,h.scope,job.id,{requestKey:input.preparedRequestKey,event:'FAILED',errorCode:'RENDER_FAILED'})
 await assert.rejects(service.recordPreparedDownload(h.db,h.scope,job.id,input),e=>e.status===409)
 assert.equal(h.rows('hardwarePrintEvent').length,1);assert.equal(h.rows('hardwarePrintJob')[0].state,'FAILED')
})
