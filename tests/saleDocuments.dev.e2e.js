const assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto')
async function main(args){
  assert.deepEqual(args,['--rollback']);require('../src/config/loadEnv')
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}},log:[]})
  const sentinel=Object.assign(new Error('Intentional rollback'),{code:'DOCUMENT_TEST_ROLLBACK'})
  const {scenarioData}=require('../src/modules/config/documentTemplates/previews'),{resolveBase,freezeProfile}=require('../src/modules/config/documentTemplates/public')
  const {processNextDocument,finishArtifact}=require('../src/modules/sales/documents/worker'),storage=require('../src/modules/sales/documents/storage')
  const {privateBucket}=require('../src/modules/config/documentTemplates/assets')
  let snapshotId,artifactId;const uploaded=[]
  try {
    assert.equal(await db.documentArtifact.count({where:{state:{in:['QUEUED','RENDERING']}}}),0,'Run the isolated rollback proof only when no user document jobs are pending')
    await assert.rejects(db.$transaction(async tx=>{
      const company=await tx.company.findFirst({where:{active:true}}),user=await tx.user.findFirst({select:{id:true}})
      assert(company&&user)
      const profile=freezeProfile(resolveBase('CLASSIC','A4'),{},[],randomUUID())
      const snapshot=await tx.documentSnapshot.create({data:{company_id:company.id,actor_id:user.id,purpose:'INTERNAL_RECEIPT',source_kind:'PREVIEW',scenario:'SHORT',expires_at:new Date(Date.now()+86400000),data:scenarioData('SHORT'),profiles:{A4:profile},branding:{logoRef:''}}});snapshotId=snapshot.id
      const artifact=await tx.documentArtifact.create({data:{company_id:company.id,snapshot_id:snapshot.id,format:'A4',profile_hash:profile.designHash,renderer_version:profile.rendererVersion,profile,state:'QUEUED'}});artifactId=artifact.id
      const result=await processNextDocument(tx,{workerId:'rollback-proof',storage:{...storage,putPdf:async input=>{uploaded.push(input.path);return storage.putPdf(input)}}})
      assert.equal(result,'ready')
      const ready=await tx.documentArtifact.findUnique({where:{id:artifact.id}})
      assert.equal(ready.state,'READY')
      const first=await storage.downloadPdf(ready),second=await storage.downloadPdf(ready)
      assert.equal(createHash('sha256').update(first).digest('hex'),ready.sha256);assert(first.equals(second))
      const fallback=profile.fallbackProfile
      const alternative=await tx.documentArtifact.create({data:{company_id:company.id,snapshot_id:snapshot.id,format:'A4',profile_hash:fallback.designHash,renderer_version:fallback.rendererVersion,profile:fallback,state:'QUEUED'}})
      assert.equal(await processNextDocument(tx,{workerId:'fallback-proof',storage:{...storage,putPdf:async input=>{uploaded.push(input.path);return storage.putPdf(input)}}}),'ready')
      const base=await tx.documentArtifact.findUnique({where:{id:alternative.id}})
      assert.equal(base.state,'READY');assert.equal(base.sha256,ready.sha256);assert.notEqual(base.path,ready.path)
      assert.equal(await finishArtifact(tx,{...ready,lease_token:randomUUID()},{path:'not-saved',sha256:'x',bytes:5,pageCount:1}),false)
      // A lease from a crashed worker can be reclaimed, but the old owner cannot confirm.
      const stalled=await tx.documentArtifact.create({data:{company_id:company.id,snapshot_id:snapshot.id,format:'LETTER',profile_hash:'b'.repeat(64),renderer_version:profile.rendererVersion,profile:freezeProfile(resolveBase('CLASSIC','LETTER')),state:'RENDERING',attempts:1,lease_token:randomUUID(),lease_until:new Date(0)}})
      assert.equal(await processNextDocument(tx,{workerId:'replacement-proof',storage:{...storage,putPdf:async input=>{uploaded.push(input.path);return storage.putPdf(input)}}}),'ready')
      assert.equal(await finishArtifact(tx,stalled,{path:'stale',sha256:'x',bytes:5,pageCount:1}),false)
      throw sentinel
    },{maxWait:10000,timeout:60000}),e=>e.code===sentinel.code)
    assert.equal(await db.documentSnapshot.count({where:{id:snapshotId}}),0)
    assert.equal(await db.documentArtifact.count({where:{id:artifactId}}),0)
    console.log(JSON.stringify({realWorker:true,privateStorage:true,identicalDownloads:true,identicalFallbackReady:true,expiredLeaseReclaimed:true,staleLeaseRejected:true,rollback:true}))
  }finally{
    if(uploaded.length){const store=await privateBucket();const result=await store.remove(uploaded);assert(!result.error,'Only explicitly created rollback artifacts must be removed')}
    await db.$disconnect()
  }
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',code:e.code||'DOCUMENT_WORKER_TEST_FAILED',name:e.name}));process.exitCode=1})
module.exports={main}
