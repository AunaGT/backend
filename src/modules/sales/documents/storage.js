const {createHash}=require('node:crypto')
const sharp=require('sharp')
const {privateBucket}=require('../../config/documentTemplates/assets')
const {downloadPublicObject,COMPANY_LOGO_BUCKET}=require('../../../services/supabaseStorage')
const {LIMITS}=require('../../config/documentTemplates/contract')
const UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const PDF_PATH=new RegExp(`^${UUID}/documents/${UUID}/(?:LETTER|A4|RECEIPT_80)/(?:${UUID}/)?[a-f0-9]{64}\\.pdf$`,'i')
const ASSET_PATH=new RegExp(`^${UUID}/assets/${UUID}\\.png$`,'i')
const fail=(code,message)=>Object.assign(new Error(message),{code,status:503})
async function getObject(path) {
  const result=await (await privateBucket()).download(path)
  if(result.error||!result.data)throw fail('DOCUMENT_STORAGE_UNAVAILABLE','No se pudo recuperar el archivo')
  return Buffer.from(await result.data.arrayBuffer())
}
async function putPdf({path,buffer,sha256}) {
  if(!PDF_PATH.test(path)||buffer.length>LIMITS.pdfBytes||createHash('sha256').update(buffer).digest('hex')!==sha256)throw fail('DOCUMENT_STORAGE_INPUT_INVALID','El archivo no es válido')
  const result=await (await privateBucket()).upload(path,buffer,{contentType:'application/pdf',upsert:false,cacheControl:'0'})
  if(result.error){
    if([400,409].includes(Number(result.error.statusCode??result.error.status))){
      const existing=await getObject(path)
      if(createHash('sha256').update(existing).digest('hex')===sha256)return path
    }
    throw fail('DOCUMENT_STORAGE_UNAVAILABLE','No se pudo guardar el PDF')
  }
  return path
}
async function loadAssets(job) {
  const refs=job.profile.resourceRefs||[],assets={};let bytes=0
  if(refs.length>5)throw fail('DOCUMENT_ASSET_LIMIT','El diseño excede los recursos admitidos')
  for(const ref of refs){
    if(ref.role==='logo') {
      if(ref.sourceUrl!==job.snapshot.branding?.logoRef)throw fail('DOCUMENT_ASSET_MISSING','El logo no coincide con el original')
      assets[ref.id]=await materializeLogo(job.company_id,ref.sourceUrl);bytes+=assets[ref.id].length;continue
    }
    if(!ASSET_PATH.test(ref.path)||!ref.path.startsWith(`${job.company_id}/`))throw fail('DOCUMENT_ASSET_MISSING','Un recurso no pertenece a este documento')
    const buffer=await getObject(ref.path)
    if(createHash('sha256').update(buffer).digest('hex')!==ref.sha256)throw fail('DOCUMENT_ASSET_CHANGED','Un recurso original cambió')
    assets[ref.id]=buffer;bytes+=buffer.length
  }
  if(bytes>LIMITS.resourceBytes||Object.keys(assets).length>5)throw fail('DOCUMENT_ASSET_LIMIT','Los recursos exceden 25 MiB o cinco imágenes')
  return assets
}
async function materializeLogo(companyId,sourceUrl) {
  const key=createHash('sha256').update(sourceUrl).digest('hex'),path=`${companyId}/logos/${key}.png`,store=await privateBucket()
  const saved=await store.download(path)
  if(!saved.error&&saved.data)return Buffer.from(await saved.data.arrayBuffer())
  const original=await downloadPublicObject(sourceUrl,COMPANY_LOGO_BUCKET)
  if(!original)throw fail('DOCUMENT_STORAGE_UNAVAILABLE','No se pudo recuperar el logo original')
  let buffer
  try{buffer=await sharp(original,{limitInputPixels:20000000}).resize(2400,2400,{fit:'inside',withoutEnlargement:true}).png().toBuffer()}catch{throw fail('DOCUMENT_ASSET_INVALID','El logo no es una imagen admitida')}
  const uploaded=await store.upload(path,buffer,{upsert:false,contentType:'image/png',cacheControl:'0'})
  if(uploaded.error)return getObject(path)
  return buffer
}
async function downloadPdf(row) {
  if(!PDF_PATH.test(row.path||'')||!row.path.startsWith(`${row.company_id}/`))throw fail('DOCUMENT_STORAGE_INPUT_INVALID','Archivo no disponible')
  const buffer=await getObject(row.path)
  if(createHash('sha256').update(buffer).digest('hex')!==row.sha256)throw fail('DOCUMENT_ARTIFACT_CHANGED','El archivo original no coincide con su huella')
  return buffer
}
module.exports={putPdf,loadAssets,downloadPdf}
