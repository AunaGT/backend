require('../src/config/loadEnv')
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),sharp=require('sharp')
const {assertSupabase}=require('../src/services/supabaseStorage')
async function prepare(args){
  assert.deepEqual(args,['--development'])
  const client=assertSupabase(),bucket='invoice-documents'
  let {data,error}=await client.storage.getBucket(bucket)
  if(error&&String(error.statusCode??error.status)==='404') {
    const created=await client.storage.createBucket(bucket,{public:false,fileSizeLimit:33554432,allowedMimeTypes:['application/pdf','image/png']})
    if(created.error)throw created.error
    ;({data,error}=await client.storage.getBucket(bucket))
  }
  assert(!error&&data?.public===false,'Private bucket must be configured before document activation')
  const path=`diagnostics/${randomUUID()}.png`,image=await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer()
  const store=client.storage.from(bucket),uploaded=await store.upload(path,image,{contentType:'image/png',upsert:false})
  if(uploaded.error)throw uploaded.error
  try {
    const {data:publicData}=store.getPublicUrl(path)
    const response=await fetch(publicData.publicUrl,{signal:AbortSignal.timeout(10000)})
    assert(!response.ok,'Anonymous public read must fail')
    const signed=await store.createSignedUrl(path,300)
    assert(!signed.error&&signed.data?.signedUrl,'Short-lived authorized download must work')
    const allowed=await fetch(signed.data.signedUrl,{signal:AbortSignal.timeout(10000)})
    assert(allowed.ok,'Signed private resource must be readable')
    console.log(JSON.stringify({privateBucket:true,anonymousDenied:true,signedRead:true,expiresSeconds:300}))
  }finally{const removed=await store.remove([path]);assert(!removed.error,'Diagnostic object cleanup failed')}
}
if(require.main===module)prepare(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({status:'error',name:e.name,code:e.code||'DOCUMENT_STORAGE_SETUP_FAILED'}));process.exitCode=1})
module.exports={prepare}
