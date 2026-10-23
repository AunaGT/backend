const sharp=require('sharp')
const {randomUUID,createHash}=require('node:crypto')
const {assertSupabase}=require('../../../services/supabaseStorage')
const {authorize,fail}=require('./permissions')
const {id,lock}=require('./service')
const BUCKET='invoice-documents'
async function privateBucket(client=assertSupabase()) {
  const {data,error}=await client.storage.getBucket(BUCKET)
  if(error||!data||data.public!==false)throw fail(503,'El almacenamiento privado de documentos no está disponible')
  return client.storage.from(BUCKET)
}
async function normalizeImage(file) {
  if(!Buffer.isBuffer(file?.buffer)||!file.buffer.length)throw fail(400,'Selecciona una imagen')
  if(file.buffer.length>5*1024*1024)throw fail(413,'La imagen admite hasta 5 MiB')
  const formats={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'}
  if(!formats[file.mimetype])throw fail(400,'Usa una imagen PNG, JPG o WebP')
  try {
    const image=sharp(file.buffer,{limitInputPixels:20000000,failOn:'warning'}),metadata=await image.metadata()
    if(metadata.format!==formats[file.mimetype]||(metadata.pages||1)!==1)throw Error('Invalid image')
    const result=await image.rotate().resize(2400,2400,{fit:'inside',withoutEnlargement:true}).png().toBuffer({resolveWithObject:true})
    return {buffer:result.data,width:result.info.width,height:result.info.height,sha256:createHash('sha256').update(result.data).digest('hex')}
  }catch {throw fail(400,'La imagen está dañada, es animada o supera 20 megapíxeles')}
}
async function draftVersion(tx,scope,versionId) {
  const version=await tx.documentTemplateVersion.findFirst({where:{company_id:scope.companyId,id:id(versionId),created_by:scope.actorId,state:'DRAFT'}})
  if(!version)throw fail(404,'Borrador no disponible para cargar imágenes')
  return version
}
async function uploadAsset(db,scope,{versionId,expectedVersion,slot,file},{getStore=privateBucket}={}) {
  authorize(scope,'manage')
  if(!/^imagen-[1-5]$/.test(slot||''))throw fail(400,'Selecciona un espacio de imagen del 1 al 5')
  if(!Number.isSafeInteger(Number(expectedVersion))||Number(expectedVersion)<1)throw fail(428,'Recarga el borrador antes de cargar una imagen')
  await draftVersion(db,scope,versionId)
  const image=await normalizeImage(file),assetId=randomUUID(),path=`${scope.companyId}/assets/${assetId}.png`
  const store=await getStore()
  const result=await store.upload(path,image.buffer,{upsert:false,contentType:'image/png',cacheControl:'0'})
  if(result.error)throw fail(503,'No se pudo guardar la imagen; intenta nuevamente')
  // Upload is outside the transaction. Re-check author/state/quota before attaching it.
  try {
    return await db.$transaction(async tx=>{
      await lock(tx,`document-assets:${scope.companyId}:${versionId}`)
      const version=await draftVersion(tx,scope,versionId)
      const claim=await tx.documentTemplate.updateMany({where:{company_id:scope.companyId,id:version.template_id,revision:Number(expectedVersion),state:'ACTIVE'},data:{revision:{increment:1}}})
      if(claim.count!==1)throw fail(409,'Otra persona cambió el borrador; recárgalo antes de cargar la imagen')
      const row=await tx.documentTemplateAsset.create({data:{id:assetId,company_id:scope.companyId,template_id:version.template_id,version_id:version.id,actor_id:scope.actorId,path,sha256:image.sha256,width:image.width,height:image.height,bytes:image.buffer.length}})
      await tx.documentTemplateVersion.updateMany({where:{company_id:scope.companyId,id:version.id,state:'DRAFT'},data:{resource_refs:{...(version.resource_refs||{}),[slot]:row.id}}})
      return {id:row.id,slot,version:Number(expectedVersion)+1,width:row.width,height:row.height,sha256:row.sha256}
    })
  }catch(error){await store.remove([path]).catch(()=>{});throw error}
}
async function readAsset(db,scope,assetId) {
  authorize(scope)
  const row=await db.documentTemplateAsset.findFirst({where:{company_id:scope.companyId,id:id(assetId)},include:{version:true}})
  if(!row||row.version?.state==='DRAFT'&&row.actor_id!==scope.actorId)throw fail(404,'Imagen no disponible')
  const expected=`${scope.companyId}/assets/${row.id}.png`
  if(row.path!==expected)throw fail(404,'Imagen no disponible')
  const result=await (await privateBucket()).download(row.path)
  if(result.error||!result.data)throw fail(503,'No se pudo abrir la imagen')
  return Buffer.from(await result.data.arrayBuffer())
}
module.exports={BUCKET,privateBucket,normalizeImage,uploadAsset,readAsset}
