const {randomUUID}=require('node:crypto')
const sharp=require('sharp')
const {prisma}=require('../../models/prisma')
const {assertSupabase}=require('../../services/supabaseStorage')
const {couponAssetIds}=require('./couponDesign')
const BUCKET='promotion-coupons',DAY=86400000
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail=(status,message)=>Object.assign(new Error(message),{status})
const storage=()=>assertSupabase().storage.from(BUCKET)
function context(ctx){
  for(const key of ['companyId','userId'])if(!UUID.test(ctx[key]||''))throw fail(400,'Contexto del cupón no válido')
  for(const key of ['draftId','promotionId','branchId'])if(ctx[key]!==undefined && !UUID.test(ctx[key]||''))throw fail(400,'Contexto del cupón no válido')
}
async function lock(tx,companyId,promotionId){
  // One lock order for quota, claiming and cleanup prevents cross-resource deadlocks.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${companyId+'-coupon-assets'},0))`
  if(promotionId)await tx.$queryRaw`SELECT id FROM promotions WHERE id=${promotionId}::uuid AND company_id=${companyId}::uuid FOR UPDATE`
}
async function promotionScope(db,ctx){
  const branchScope=ctx.branchId?{OR:[{applies_to_all_branches:true},{branches:{some:{branch_id:ctx.branchId}}}]}:{}
  if(ctx.promotionId && !await db.promotion.findFirst({where:{id:ctx.promotionId,company_id:ctx.companyId,deleted:false,...branchScope}}))throw fail(404,'Promoción no disponible')
}
const available=(row,ctx)=>row && row.company_id===ctx.companyId && row.status==='READY' &&
  (row.promotion_id ? row.promotion_id===ctx.promotionId : row.created_by===ctx.userId && row.draft_id===ctx.draftId && row.expires_at>new Date())
function ownPath(row){return row.storage_path===`${row.company_id}/coupons/${row.id}.webp` && UUID.test(row.id) && UUID.test(row.company_id)}
async function resolveCouponAssets(ctx,ids){
  context(ctx)
  if(!Array.isArray(ids) || ids.length>5 || new Set(ids).size!==ids.length || ids.some(id=>!UUID.test(id)))throw fail(400,'Imágenes no válidas')
  if(!ids.length)return[]
  await promotionScope(prisma,ctx)
  const rows=await prisma.promotionCouponAsset.findMany({where:{id:{in:ids},company_id:ctx.companyId}})
  if(rows.length!==ids.length || rows.some(r=>!available(r,ctx)||!ownPath(r)))throw fail(404,'Imagen del cupón no disponible')
  let data
  try{const result=await storage().createSignedUrls(rows.map(r=>r.storage_path),3600);if(result.error)throw result.error;data=result.data}catch{throw fail(503,'No se pudieron cargar las imágenes del cupón')}
  return rows.map(row=>{
    const url=data?.find(s=>s.path===row.storage_path && !s.error)?.signedUrl
    if(!url)throw fail(503,'No se pudo cargar una imagen del cupón')
    return{id:row.id,url,expiresAt:new Date(Date.now()+3600000).toISOString(),width:row.width,height:row.height}
  })
}
// Storage a veces falla por la red (cortes, TLS, 5xx) o se queda sin responder: lo pasajero se reintenta
// y cada intento tiene límite de tiempo, para no dejar al usuario esperando ni el registro en UPLOADING.
const uploadPolicy={timeoutMs:20000,retryDelaysMs:[300,1000]}
const transient=error=>!error?.status||error.status>=500||[408,429].includes(error.status)
async function storeObject(path,buffer){
  for(let attempt=0;;attempt++){
    let timer
    try{
      const result=await Promise.race([
        // upsert en reintentos: la ruta es única por imagen y el intento anterior pudo haberse guardado.
        storage().upload(path,buffer,{upsert:attempt>0,contentType:'image/webp',cacheControl:'0'}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Storage no respondió en ${uploadPolicy.timeoutMs} ms`)),uploadPolicy.timeoutMs)}),
      ])
      if(result.error)throw result.error
      if(!result.data)throw Error('Storage no devolvió datos')
      return
    }catch(error){
      if(attempt>=uploadPolicy.retryDelaysMs.length || !transient(error))throw error
      console.warn('[coupon-assets] Reintentando la subida a Storage:',error?.message||error)
      await new Promise(resolve=>setTimeout(resolve,uploadPolicy.retryDelaysMs[attempt]))
    }finally{clearTimeout(timer)}
  }
}
async function uploadCouponAsset(ctx,file){
  context(ctx);if(!ctx.draftId)throw fail(400,'Falta el borrador del cupón')
  if(!file?.buffer?.length)throw fail(400,'Selecciona una imagen')
  if(file.buffer.length>5*1024*1024)throw fail(413,'La imagen admite hasta 5 MB')
  const formats={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'}
  if(!formats[file.mimetype])throw fail(400,'Selecciona una imagen PNG, JPG o WebP')
  let buffer,width,height
  try{
    const image=sharp(file.buffer,{limitInputPixels:20000000,failOn:'warning'})
    const meta=await image.metadata();if(meta.format!==formats[file.mimetype] || (meta.pages??1)!==1)throw Error()
    const result=await image.rotate().resize(2400,2400,{fit:'inside',withoutEnlargement:true}).webp({quality:90}).toBuffer({resolveWithObject:true})
    buffer=result.data;width=result.info.width;height=result.info.height
  }catch{throw fail(400,'La imagen está dañada, es animada o supera las dimensiones admitidas')}
  const id=randomUUID(),path=`${ctx.companyId}/coupons/${id}.webp`
  await prisma.$transaction(async tx=>{
    await lock(tx,ctx.companyId,ctx.promotionId);await promotionScope(tx,ctx)
    const count=await tx.promotionCouponAsset.count({where:{company_id:ctx.companyId,created_by:ctx.userId,draft_id:ctx.draftId,promotion_id:null}})
    if(count>=10)throw fail(409,'El borrador ya tiene diez imágenes. Retira una antes de subir otra.')
    await tx.promotionCouponAsset.create({data:{id,company_id:ctx.companyId,created_by:ctx.userId,draft_id:ctx.draftId,promotion_id:null,storage_path:path,status:'UPLOADING',width,height,created_at:new Date(),expires_at:new Date(Date.now()+DAY)}})
  })
  try{
    await storeObject(path,buffer)
    await prisma.promotionCouponAsset.update({where:{id},data:{status:'READY'}})
  }catch(error){
    // Solo al registro del servidor: la causa real (bucket, red, permisos) sin exponerla al cliente.
    console.error('[coupon-assets] Falló la subida a Storage:',error?.message||error,error?.statusCode||'')
    await prisma.promotionCouponAsset.update({where:{id},data:{status:'DELETING'}})
    throw fail(503,'No se pudo guardar la imagen del cupón. Intenta nuevamente.')
  }
  return(await resolveCouponAssets(ctx,[id]))[0]
}
async function claimCouponAssets(tx,ctx,promotionId,design){
  context(ctx);await lock(tx,ctx.companyId,promotionId)
  const ids=couponAssetIds(design),scope={...ctx,promotionId}
  const rows=ids.length?await tx.promotionCouponAsset.findMany({where:{id:{in:ids},company_id:ctx.companyId}}):[]
  if(rows.length!==ids.length || rows.some(r=>!available(r,scope)||!ownPath(r)))throw fail(404,'Imagen del cupón no disponible. Vuelve a cargarla.')
  if(ids.length){
    await tx.$queryRaw`SELECT id FROM promotion_coupon_assets WHERE company_id=${ctx.companyId}::uuid FOR UPDATE`
    await tx.promotionCouponAsset.updateMany({where:{id:{in:ids},company_id:ctx.companyId},data:{promotion_id:promotionId,expires_at:null}})
  }
  await tx.promotionCouponAsset.updateMany({where:{company_id:ctx.companyId,promotion_id:promotionId,id:{notIn:ids}},data:{expires_at:new Date(Date.now()+DAY)}})
}
async function removeDraftCouponAsset(ctx,id){
  context(ctx);if(!UUID.test(id))throw fail(400,'Imagen no válida')
  const row=await prisma.$transaction(async tx=>{
    await lock(tx,ctx.companyId)
    const row=await tx.promotionCouponAsset.findFirst({where:{id,company_id:ctx.companyId,created_by:ctx.userId,draft_id:ctx.draftId,promotion_id:null}})
    if(!row || !ownPath(row))throw fail(404,'Imagen temporal no disponible')
    await tx.promotionCouponAsset.update({where:{id},data:{status:'DELETING'}});return row
  })
  await removeTombstone(row)
}
async function removeTombstone(row){
  if(!ownPath(row))throw fail(400,'Ruta de imagen no válida')
  const {error}=await storage().remove([row.storage_path]);if(error)throw fail(503,'No se pudo retirar la imagen temporal')
  await prisma.promotionCouponAsset.deleteMany({where:{id:row.id,status:'DELETING'}})
}
async function cleanupCouponAssets({limit=50}={}){
  const rows=await prisma.promotionCouponAsset.findMany({where:{OR:[{status:'DELETING'},{expires_at:{lte:new Date()}},{promotion_id:null,expires_at:null,created_at:{lt:new Date(Date.now()-DAY)}}]},take:Math.min(50,Math.max(1,limit))})
  for(const candidate of rows){
    try{
      const row=await prisma.$transaction(async tx=>{
        await lock(tx,candidate.company_id,candidate.promotion_id)
        const row=await tx.promotionCouponAsset.findFirst({where:{id:candidate.id}})
        if(!row)return null
        const promo=row.promotion_id?await tx.promotion.findFirst({where:{id:row.promotion_id,company_id:row.company_id}}):null
        if(promo && !promo.deleted && couponAssetIds(promo.coupon_design).includes(row.id)){
          await tx.promotionCouponAsset.update({where:{id:row.id},data:{expires_at:null}});return null
        }
        if(row.status!=='DELETING' && !(row.expires_at && row.expires_at<=new Date()) && !(row.promotion_id===null && row.expires_at===null && row.created_at<new Date(Date.now()-DAY)))return null
        await tx.promotionCouponAsset.update({where:{id:row.id},data:{status:'DELETING'}});return row
      })
      if(row)await removeTombstone(row)
    }catch{console.warn('[coupon-assets] Limpieza pendiente; se reintentará sin perder el registro')}
  }
}
module.exports={uploadPolicy,uploadCouponAsset,resolveCouponAssets,claimCouponAssets,removeDraftCouponAsset,cleanupCouponAssets}
