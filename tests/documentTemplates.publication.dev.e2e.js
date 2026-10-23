// Explicit opt-in: exercises real publication and Storage, then rolls back its rows.
const assert=require('node:assert/strict')
async function main(args){
  assert.deepEqual(args,['--rollback']);require('../src/config/loadEnv')
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}},log:[]})
  const {saveDraft,publishTemplate,resolveProfiles}=require('../src/modules/config/documentTemplates/service')
  const {requestPreview}=require('../src/modules/config/documentTemplates/previews')
  const {resolveBase}=require('../src/modules/config/documentTemplates/public')
  const {processNextDocument}=require('../src/modules/sales/documents/worker'),storage=require('../src/modules/sales/documents/storage')
  const {privateBucket}=require('../src/modules/config/documentTemplates/assets')
  const sentinel=Object.assign(new Error('Intentional rollback'),{code:'DOCUMENT_TEST_ROLLBACK'}),uploaded=[];let templateId
  try{
    assert.equal(await db.documentArtifact.count({where:{state:{in:['QUEUED','RENDERING']}}}),0,'User document jobs must finish before this rollback proof')
    await assert.rejects(db.$transaction(async tx=>{
      const company=await tx.company.findFirst({where:{active:true},select:{id:true}}),user=await tx.user.findFirst({select:{id:true}});assert(company&&user)
      const scoped=new Proxy(tx,{get:(target,key)=>key==='$transaction'?fn=>fn(tx):Reflect.get(target,key)})
      const scope={companyId:company.id,actorId:user.id,isAdmin:true},design=resolveBase('CLASSIC','A4')
      design.blocks.find(b=>b.kind==='HEADER').settings.showLogo=false
      const draft=await saveDraft(scoped,scope,{expectedVersion:0,design,name:'Rollback publication proof',requestKey:'proof-save'});templateId=draft.id
      const ids=[]
      for(const scenario of ['SHORT','LONG','LONG_TEXT']){
        const artifact=await requestPreview(scoped,scope,{templateId:draft.id,expectedVersion:draft.version,scenario,requestKey:`proof-${scenario}`});ids.push(artifact.id)
        assert.equal(await processNextDocument(tx,{workerId:'publication-proof',storage:{...storage,putPdf:async input=>{uploaded.push(input.path);return storage.putPdf(input)}}}),'ready')
        assert.equal((await tx.documentArtifact.findUnique({where:{id:artifact.id}})).state,'READY')
      }
      const published=await publishTemplate(scoped,scope,{id:draft.id,expectedVersion:draft.version,setDefault:true,validationArtifactIds:ids,requestKey:'proof-publish'})
      assert.equal(published.status,'PUBLISHED');assert.equal((await resolveProfiles(tx,scope,'INTERNAL_RECEIPT')).A4.templateVersionId,published.versionId)
      const edited=await saveDraft(scoped,scope,{id:draft.id,expectedVersion:published.version,design,name:'Later draft',requestKey:'proof-edit'})
      assert.equal(edited.status,'DRAFT');assert.notEqual(edited.versionId,published.versionId)
      assert.equal((await resolveProfiles(tx,scope,'INTERNAL_RECEIPT')).A4.templateVersionId,published.versionId)
      throw sentinel
    },{maxWait:10000,timeout:120000}),e=>e.code===sentinel.code)
    assert.equal(await db.documentTemplate.count({where:{id:templateId}}),0)
    console.log(JSON.stringify({trustedPreviews:3,realWorker:true,publishedDefault:true,laterDraftPreservesDefault:true,rollback:true}))
  }finally{
    if(uploaded.length){const result=await (await privateBucket()).remove(uploaded);assert(!result.error,'Remove only exact proof objects')}
    await db.$disconnect()
  }
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',code:e.code||'DOCUMENT_PUBLICATION_TEST_FAILED',name:e.name}));process.exitCode=1})
module.exports={main}
