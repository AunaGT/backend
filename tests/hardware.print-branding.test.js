const test=require('node:test'),assert=require('node:assert/strict'),{withMocks}=require('./helpers/reportHarness.cjs')
test('logo cleanup retains a referenced immutable object and removes only unused objects',async()=>{
 const {cleanupPrintLogo}=require('../src/modules/config/hardware/printing/branding')
 const objects=new Set(['old','unused']),db={$transaction:run=>run({$executeRaw:async()=>0,documentSnapshot:{count:async()=>0},hardwarePrintJob:{count:async({where})=>where.snapshot.path.join('.')==='options.logoUrl'&&where.snapshot.equals==='old'?1:0}})}
 const remove=async url=>objects.delete(url)
 assert.equal(await cleanupPrintLogo(db,'old',remove),undefined);assert.equal(objects.has('old'),true)
 assert.equal(await cleanupPrintLogo(db,'unused',remove),undefined);assert.equal(objects.has('unused'),false)
})
test('logo cleanup also retains the logo of a new document snapshot before the worker has loaded it',async()=>{
 const {cleanupPrintLogo}=require('../src/modules/config/hardware/printing/branding');let removed=false
 const db={$transaction:run=>run({$executeRaw:async()=>0,hardwarePrintJob:{count:async()=>0},documentSnapshot:{count:async({where})=>{assert.deepEqual(where.branding,{path:['logoRef'],equals:'frozen-logo'});return 1}}})}
 assert.equal(await cleanupPrintLogo(db,'frozen-logo',async()=>{removed=true}),undefined)
 assert.equal(removed,false)
})
test('job logo retrieval uses the authorized frozen URL, never current settings or an incoming URL',async()=>{
 const {harness,ids}=require('./helpers/hardwareHarness.cjs'),{randomUUID}=require('node:crypto'),h=harness();h.scope.permissions=['sales.create']
 const sale=await h.db.sale.create({data:{branch_id:ids.branch,branch:{company_id:ids.company},created_by:ids.actor}})
 const job=await h.db.hardwarePrintJob.create({data:{company_id:ids.company,branch_id:ids.branch,actor_id:ids.actor,source_kind:'SALE_TICKET',source_id:sale.id,snapshot:{version:1,options:{logoUrl:'old'}},request_key:randomUUID()}})
 await withMocks({[require.resolve('../src/utils/pdfBranding')]:{fetchLogoForHttp:async url=>({buffer:Buffer.from(url),contentType:'image/png'})}},require.resolve('../src/modules/config/hardware/printing/service'),async service=>{
  const result=await service.jobLogo(h.db,h.scope,job.id);assert.equal(result.buffer.toString(),'old')
  await assert.rejects(service.jobLogo(h.db,{...h.scope,actorId:randomUUID()},job.id),e=>e.status===404)
 })
})
