const {randomUUID,createHash}=require('node:crypto')
const {fork}=require('node:child_process')
const path=require('node:path')
const {performance}=require('node:perf_hooks')
const {LIMITS}=require('../../config/documentTemplates/contract')
const TRANSIENT=new Set(['DOCUMENT_STORAGE_UNAVAILABLE','P1001','P1002','P1008','P1017','WORKER_INTERRUPTED'])
function error(code,message){return Object.assign(new Error(message),{code})}
async function finishArtifact(db,job,{path,sha256,bytes,pageCount}) {
  const result=await db.documentArtifact.updateMany({where:{id:job.id,company_id:job.company_id,state:'RENDERING',lease_token:job.lease_token,lease_until:{gt:new Date()}},data:{state:'READY',path,sha256,bytes,page_count:pageCount,error_code:null,lease_token:null,lease_until:null}})
  return result.count===1
}
function supervisedRender(input) {
  return new Promise((resolve,reject)=>{
    const child=fork(path.join(__dirname,'renderChild.js'),[],{execArgv:['--max-old-space-size=256'],stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',env:{PATH:process.env.PATH}})
    let settled=false
    const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');err?reject(err):resolve(value)}
    const timer=setTimeout(()=>finish(error('DOCUMENT_TIMEOUT','Se agotó el tiempo de generación')),input.limits.preview?10000:30000)
    child.on('error',()=>finish(error('WORKER_INTERRUPTED','No se pudo iniciar el proceso de documento')))
    child.on('exit',()=>finish(error('WORKER_INTERRUPTED','Se interrumpió el proceso de documento')))
    child.on('message',message=>{
      if(message.error)return finish(error(/^[A-Z_]{3,80}$/.test(message.error)?message.error:'DOCUMENT_RENDER_FAILED','No se pudo generar el documento'))
      if(!Buffer.isBuffer(message.buffer)||message.buffer.length>LIMITS.pdfBytes)return finish(error('DOCUMENT_PDF_TOO_LARGE','El archivo excede el tamaño permitido'))
      finish(null,message)
    })
    child.send(input)
  })
}
async function processNextDocument(db,{workerId,render=supervisedRender,storage=require('./storage'),clock=()=>new Date(),onMetrics=()=>{}}={}) {
  if(!workerId)throw error('WORKER_ID_REQUIRED','Identifica el proceso de documentos')
  const token=randomUUID(),now=clock()
  const [claim]=await db.$queryRaw`WITH picked AS (
    SELECT id,attempts FROM document_artifacts WHERE
      (state='QUEUED' AND available_at<=${now}) OR (state='RENDERING' AND lease_until<=${now})
    ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
  ) UPDATE document_artifacts a SET state='RENDERING',attempts=LEAST(a.attempts+1,3),lease_token=${token}::uuid,
    lease_until=${now}+interval '120 seconds',updated_at=${now}
    FROM picked p WHERE a.id=p.id RETURNING a.*,p.attempts AS previous_attempts`
  if(!claim)return 'idle'
  const job=await db.documentArtifact.findFirst({where:{company_id:claim.company_id,id:claim.id,state:'RENDERING',lease_token:claim.lease_token},include:{snapshot:true}})
  if(!job||job.lease_token!==claim.lease_token)return 'retry'
  let lost=false,heartbeatBusy=false
  const heartbeat=setInterval(async()=>{
    if(heartbeatBusy)return;heartbeatBusy=true
    try{const r=await db.documentArtifact.updateMany({where:{id:job.id,state:'RENDERING',lease_token:job.lease_token},data:{lease_until:new Date(clock().getTime()+120000)}});if(r.count!==1)lost=true}catch{lost=true}finally{heartbeatBusy=false}
  },15000)
  heartbeat.unref?.()
  try {
    if(claim.previous_attempts>=3)throw error('DOCUMENT_ATTEMPTS_EXHAUSTED','Se agotaron los intentos automáticos')
    if(!job.snapshot)throw error('DOCUMENT_INPUT_MISSING','No se encontró el documento original')
    if(job.snapshot.source_kind==='PREVIEW'&&new Date(job.snapshot.expires_at)<=clock())throw error('DOCUMENT_PREVIEW_EXPIRED','La vista previa venció')
    if(Buffer.byteLength(JSON.stringify({data:job.snapshot.data,profile:job.profile}))>LIMITS.snapshotBytes)throw error('DOCUMENT_DATA_TOO_LARGE','Datos demasiado grandes')
    const assetsStart=performance.now(),assets=await storage.loadAssets(job),assetsMs=performance.now()-assetsStart,renderStart=performance.now()
    const result=await render({data:job.snapshot.data,profile:job.profile,assets,limits:{preview:job.snapshot.source_kind==='PREVIEW'}})
    const renderMs=performance.now()-renderStart
    if(lost)return 'retry'
    if(!Buffer.isBuffer(result.buffer)||result.buffer.length>LIMITS.pdfBytes)throw error('DOCUMENT_PDF_TOO_LARGE','Archivo demasiado grande')
    const sha256=createHash('sha256').update(result.buffer).digest('hex'),objectPath=`${job.company_id}/documents/${job.snapshot_id}/${job.format}/${job.id}/${sha256}.pdf`
    const storageStart=performance.now()
    await storage.putPdf({path:objectPath,buffer:result.buffer,sha256})
    onMetrics({assetsMs,renderMs,storageMs:performance.now()-storageStart,queueAgeMs:job.created_at?Math.max(0,now-new Date(job.created_at)):null,bytes:result.buffer.length,pages:result.pageCount,observedRss:result.observedRss||null})
    if(lost)return 'retry'
    return await finishArtifact(db,job,{path:objectPath,sha256,bytes:result.buffer.length,pageCount:result.pageCount})?'ready':'retry'
  }catch(e){
    const code=/^[A-Z_0-9]{3,80}$/.test(e?.code||'')?e.code:e?.status===503?'DOCUMENT_STORAGE_UNAVAILABLE':'DOCUMENT_RENDER_FAILED'
    const retry=TRANSIENT.has(code)&&job.attempts<3
    await db.documentArtifact.updateMany({where:{id:job.id,state:'RENDERING',lease_token:job.lease_token},data:{state:retry?'QUEUED':'FAILED',error_code:code,lease_token:null,lease_until:null,available_at:new Date(clock().getTime()+(job.attempts===1?2000:10000))}})
    return retry?'retry':'failed'
  }finally{clearInterval(heartbeat)}
}
module.exports={finishArtifact,processNextDocument,supervisedRender}
