const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs'),{withMocks}=require('./helpers/reportHarness.cjs')
const target=require.resolve('../src/modules/config/hardware/printing/service'),branding=require.resolve('../src/utils/pdfBranding')
async function fixture(){
 const h=harness();h.scope.permissions=['sales.create']
 const sale=await h.db.sale.create({data:{branch_id:ids.branch,branch:{company_id:ids.company},created_by:ids.actor,total:'3',sale_items:[{item_name:'Producto',qty:'1',price:'3'}]}})
 await h.db.systemSetting.create({data:{company_id:ids.company,key:'company_logo_url',value:'https://example.test/original.png'}})
 const input={requestKey:randomUUID(),source:{kind:'SALE_TICKET',id:sale.id},document:'MAIN'}
 // Already persisted V1 jobs remain readable; new jobs always capture V2 artifacts.
 const snapshot=await require('../src/modules/config/hardware/printing/sources').resolvePrintSource(h.db,h.scope,input.source)
 const request_hash=require('node:crypto').createHash('sha256').update(JSON.stringify(require('../src/modules/config/hardware/printing/validation').jobInput(input))).digest('hex')
 await h.db.hardwarePrintJob.create({data:{company_id:ids.company,branch_id:ids.branch,actor_id:ids.actor,request_key:input.requestKey,request_hash,source_kind:'SALE_TICKET',source_id:sale.id,snapshot,route_snapshot:{},document:'MAIN',pages:[],state:'CREATED'}})
 return{...h,input}
}
test('authorized envelope carries its frozen logo outside the print transaction without storing base64',async()=>{
 const h=await fixture();let active=false,loads=0;const transaction=h.db.$transaction
 h.db.$transaction=async run=>transaction(async tx=>{active=true;try{return await run(tx)}finally{active=false}})
 await withMocks({[branding]:{fetchLogoForHttp:async url=>{loads++;assert.equal(active,false);assert.equal(url,'https://example.test/original.png');return{buffer:Buffer.from('PNG'),contentType:'image/png'}}}},target,async api=>{
  const result=await api.createJob(h.db,h.scope,h.input,{includeDocument:true,includeLogo:true})
  assert.equal(loads,1);assert.equal(result.document.options.logoDataUrl,'data:image/png;base64,UE5H')
  assert.equal(h.rows('hardwarePrintJob')[0].snapshot.options.logoDataUrl,undefined)
  await assert.rejects(api.createJob(h.db,{...h.scope,actorId:randomUUID()},h.input,{includeDocument:true,includeLogo:true}),e=>[404,409].includes(e.status));assert.equal(loads,1)
 })
})
for(const kind of ['missing','error','large'])test(`optional ${kind} logo does not prevent an authorized envelope`,async()=>{
 const h=await fixture()
 await withMocks({[branding]:{fetchLogoForHttp:async()=>{if(kind==='error')throw Error('private URL');return kind==='large'?{buffer:Buffer.alloc(1048577),contentType:'image/png'}:null}}},target,async api=>{
  const result=await api.createJob(h.db,h.scope,h.input,{includeDocument:true,includeLogo:true});assert.equal(result.document.options.logoDataUrl,'');assert.equal(result.job.state,'CREATED')
 })
})
test('optional logo timeout releases the document after 1500ms without extending the transaction',async t=>{
 assert.equal(typeof require('../src/modules/config/hardware/printing/validation').documentOptions,'function')
 const h=await fixture();t.mock.timers.enable({apis:['setTimeout']});let begin,signal;const started=new Promise(r=>begin=r)
 await withMocks({[branding]:{fetchLogoForHttp:(_,options)=>{signal=options?.signal;begin();return new Promise(()=>{})}}},target,async api=>{
  const pending=api.createJob(h.db,h.scope,h.input,{includeDocument:true,includeLogo:true})
  await started;t.mock.timers.tick(1500);const result=await pending;assert.equal(result.document.options.logoDataUrl,'');assert.equal(h.rows('hardwarePrintJob').length,1);assert.equal(signal?.aborted,true)
 })
})
test('logo opt-in requires an envelope and rejects malformed flags before writes',async()=>{
 const {documentOptions}=require('../src/modules/config/hardware/printing/validation');assert.equal(typeof documentOptions,'function')
 assert.deepEqual(documentOptions({}),{includeDocument:false,includeLogo:false})
 assert.deepEqual(documentOptions({includeDocument:'true',includeLogo:'true'}),{includeDocument:true,includeLogo:true})
 for(const input of [{includeLogo:'true'},{includeDocument:'true',includeLogo:false},{includeDocument:'true',includeLogo:['true']}])assert.throws(()=>documentOptions(input),e=>e.status===400)
 const h=await fixture(),before=h.rows('hardwarePrintJob').length;await assert.rejects(require(target).createJob(h.db,h.scope,h.input,{includeLogo:true}),e=>e.status===400);assert.equal(h.rows('hardwarePrintJob').length,before)
})
