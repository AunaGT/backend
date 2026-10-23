const test=require('node:test'),assert=require('node:assert/strict')
const {processNextDocument,finishArtifact}=require('../src/modules/sales/documents/worker')
const {resolveBase,freezeProfile}=require('../src/modules/config/documentTemplates/public')
const {sampleData}=require('./fixtures/documentTemplates/data')
function fixture(){
  const job={id:'11111111-1111-4111-8111-111111111111',company_id:'22222222-2222-4222-8222-222222222222',snapshot_id:'33333333-3333-4333-8333-333333333333',format:'A4',state:'QUEUED',attempts:0,profile:freezeProfile(resolveBase('CLASSIC','A4')),snapshot:{source_kind:'SALE',data:sampleData(),branding:{logoRef:''}}}
  let validLease=true
  const db={$queryRaw:async()=>{if(job.state==='READY')return [];job.state='RENDERING';job.attempts++;job.lease_token='44444444-4444-4444-8444-444444444444';return [{...job}]},documentArtifact:{findFirst:async()=>job,updateMany:async({where,data})=>{
    if(!validLease||where.lease_token&&where.lease_token!==job.lease_token)return {count:0}
    Object.assign(job,data);return {count:1}
  }}}
  return {db,job,expire:()=>validLease=false}
}
test('worker stores a ready artifact once and ignores completion from a stale lease',async()=>{
  const {db,job,expire}=fixture(),paths=[]
  const storage={loadAssets:async()=>({}),putPdf:async input=>{paths.push(input.path);return input.path}}
  assert.equal(await processNextDocument(db,{workerId:'test',storage,render:async()=>({buffer:Buffer.from('%PDF-test'),pageCount:1,rendererVersion:'INVOICE_BLOCKS_V1'})}),'ready')
  assert.equal(job.state,'READY');assert.equal(paths.length,1);assert.match(paths[0],/\/documents\/.*\/A4\/[a-f0-9-]{36}\/[a-f0-9]{64}\.pdf$/)
  assert.equal(await processNextDocument(db,{workerId:'test',storage,render:async()=>assert.fail('must not render again')}),'idle')
  expire();assert.equal(await finishArtifact(db,job,{path:'old',sha256:'x',bytes:5,pageCount:1}),false)
})
test('transient storage failures retry at most three attempts; invalid layouts fail immediately',async()=>{
  const {db,job}=fixture(),storage={loadAssets:async()=>({}),putPdf:async()=>{throw Object.assign(new Error('Storage unavailable'),{code:'DOCUMENT_STORAGE_UNAVAILABLE'})}}
  const options={workerId:'test',storage,render:async()=>({buffer:Buffer.from('%PDF-test'),pageCount:1})}
  assert.equal(await processNextDocument(db,options),'retry');assert.equal(job.state,'QUEUED')
  assert.equal(await processNextDocument(db,options),'retry')
  assert.equal(await processNextDocument(db,options),'failed');assert.equal(job.attempts,3)
  const bad=fixture()
  assert.equal(await processNextDocument(bad.db,{...options,render:async()=>{throw Object.assign(new Error('Too high'),{code:'DOCUMENT_ROW_TOO_TALL'})}}),'failed')
  assert.equal(bad.job.attempts,1)
})
test('expired private previews fail before loading resources or rendering',async()=>{
  const {db,job}=fixture();job.snapshot.source_kind='PREVIEW';job.snapshot.expires_at=new Date(0)
  assert.equal(await processNextDocument(db,{workerId:'expired-check',storage:{loadAssets:async()=>assert.fail('Expired preview must not load files')},render:async()=>assert.fail('Expired preview must not render')}),'failed')
  assert.equal(job.error_code,'DOCUMENT_PREVIEW_EXPIRED')
})
test('a reclaimed job cannot lend its lease to the worker that claimed it earlier',async()=>{
  const {db,job}=fixture();let rendered=false
  db.documentArtifact.findFirst=async()=>({...job,lease_token:'55555555-5555-4555-8555-555555555555'})
  const result=await processNextDocument(db,{workerId:'old-owner',storage:{loadAssets:async()=>({}),putPdf:async()=>{}},render:async()=>{rendered=true;return {buffer:Buffer.from('%PDF-test'),pageCount:1}}})
  assert.equal(result,'retry');assert.equal(rendered,false);assert.equal(job.state,'RENDERING')
})
test('byte-identical original and fallback PDFs each reach READY without colliding in Storage',async()=>{
  const first=fixture(),second=fixture(),paths=new Set()
  second.job.id='66666666-6666-4666-8666-666666666666';second.job.profile.designHash='a'.repeat(64)
  const storage={loadAssets:async()=>({}),putPdf:async()=>{}},render=async()=>({buffer:Buffer.from('%PDF-same-output'),pageCount:1})
  for(const {db,job} of [first,second]){
    const update=db.documentArtifact.updateMany
    db.documentArtifact.updateMany=async input=>{
      if(input.data.state==='READY'&&paths.has(input.data.path))throw Object.assign(new Error('Unique artifact path'),{code:'P2002'})
      const result=await update(input);if(input.data.state==='READY'&&result.count)paths.add(input.data.path);return result
    }
    assert.equal(await processNextDocument(db,{workerId:'same-bytes',storage,render}),'ready');assert.equal(job.state,'READY')
  }
  assert.equal(paths.size,2)
})
