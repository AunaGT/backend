const {randomUUID}=require('node:crypto')
const {lock,id,requestKey,command}=require('../../config/documentTemplates/service')
const {fail}=require('../../config/documentTemplates/permissions')
const {hash,schemaManifest}=require('../../config/documentTemplates/contract')
const {prepareSaleSnapshot,authorizeSaleDocument}=require('./snapshot')
function artifactDto(row){return {id:row.id,snapshotId:row.snapshot_id,format:row.format,state:row.state,...(row.error_code?{errorCode:row.error_code}:{}),filename:`comprobante-${row.snapshot_id.slice(0,8)}-${row.format}.pdf`}}
async function requestPreparedArtifact(db,scope,snapshot,format,{useBase=false}={}) {
  if(snapshot.company_id!==scope.companyId)throw fail(404,'Documento no encontrado')
  if(!schemaManifest.formats.includes(format))throw fail(400,'Formato no admitido')
  const selected=snapshot.profiles[format],profile=useBase?selected?.fallbackProfile:selected
  if(!profile)throw fail(409,'No hay un diseño capturado para este formato')
  return db.$transaction(async tx=>{
    await lock(tx,`document-artifact:${scope.companyId}:${snapshot.id}:${format}:${profile.designHash}`)
    const where={company_id:scope.companyId,snapshot_id:snapshot.id,format,profile_hash:profile.designHash,renderer_version:profile.rendererVersion}
    let row=await tx.documentArtifact.findFirst({where})
    if(!row)row=await tx.documentArtifact.create({data:{...where,profile,state:'QUEUED'}})
    return artifactDto(row)
  })
}
async function requestArtifact(db,scope,input) {
  requestKey(input.requestKey)
  const snapshot=await prepareSaleSnapshot(db,scope,input)
  return requestPreparedArtifact(db,scope,snapshot,input.format||snapshot.branding.preferredFormat||'LETTER',{useBase:input.useBase===true})
}
async function artifactRow(db,scope,saleId,artifactId) {
  await authorizeSaleDocument(db,scope,saleId);id(artifactId)
  const row=await db.documentArtifact.findFirst({where:{company_id:scope.companyId,id:artifactId,snapshot:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:saleId,source_kind:'SALE'}}})
  if(!row)throw fail(404,'Documento no encontrado');return row
}
async function getArtifact(db,scope,{saleId,artifactId}){return artifactDto(await artifactRow(db,scope,saleId,artifactId))}
async function downloadArtifact(db,scope,{saleId,artifactId},storage=require('./storage')) {
  const row=await artifactRow(db,scope,saleId,artifactId)
  if(row.state!=='READY')throw fail(409,'El documento aún no está listo','DOCUMENT_NOT_READY')
  const buffer=await storage.downloadPdf(row)
  await db.documentEvent.create({data:{company_id:scope.companyId,actor_id:scope.actorId,action:'DOWNLOAD',request_key:randomUUID(),input_hash:hash({artifactId}),entity_id:row.id,result:{artifactId:row.id}}})
  return {buffer,filename:artifactDto(row).filename}
}
async function retryArtifact(db,scope,input) {
  const row=await artifactRow(db,scope,input.saleId,input.artifactId)
  return command(db,scope,'RETRY_DOCUMENT',input,async tx=>{
    const claim=await tx.documentArtifact.updateMany({where:{company_id:scope.companyId,id:row.id,state:'FAILED'},data:{state:'QUEUED',attempts:0,error_code:null,lease_token:null,lease_until:null,available_at:new Date()}})
    if(claim.count!==1)throw fail(409,'Solo se puede reintentar un documento fallido')
    return artifactDto({...row,state:'QUEUED',error_code:null})
  })
}
module.exports={artifactDto,requestPreparedArtifact,requestArtifact,artifactRow,getArtifact,downloadArtifact,retryArtifact}
