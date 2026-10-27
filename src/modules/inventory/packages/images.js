const {randomUUID}=require('node:crypto')
const sharp=require('sharp')
const {assertSupabase}=require('../../../services/supabaseStorage')
const {uuid}=require('./definition')
const MAX_IMAGE_BYTES=5*1024*1024
const formats={'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'}
const fail=(status,message)=>Object.assign(new Error(message),{status,code:'PACKAGE_IMAGE_INVALID'})

async function storePackageImage(companyId,file,{storage}={}){
 uuid(companyId,'companyId')
 if(!file?.buffer?.length)throw fail(400,'Selecciona una imagen JPG, PNG o WebP')
 if(file.buffer.length>MAX_IMAGE_BYTES)throw fail(413,'La imagen admite hasta 5 MB')
 if(!formats[file.mimetype])throw fail(400,'Selecciona una imagen JPG, PNG o WebP')
 let buffer
 try{
  const image=sharp(file.buffer,{limitInputPixels:20000000,failOn:'warning'}),metadata=await image.metadata()
  if(metadata.format!==formats[file.mimetype]||(metadata.pages??1)!==1)throw Error('Formato no válido')
  // Sharp does not expose APNG frames; inspect chunk boundaries, not text inside chunk data.
  if(metadata.format==='png')for(let offset=8;offset<file.buffer.length;){
   if(offset+12>file.buffer.length)throw Error('PNG incompleto')
   const length=file.buffer.readUInt32BE(offset),type=file.buffer.toString('ascii',offset+4,offset+8)
   if(length>file.buffer.length-offset-12||['acTL','fcTL','fdAT'].includes(type))throw Error('PNG no estático')
   offset+=length+12
  }
  buffer=await image.rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer()
 }catch{throw fail(400,'La imagen está dañada, es animada o supera las dimensiones admitidas')}
 const path=`${companyId}/packages/${randomUUID()}.webp`
 try{
  const bucket=(storage??assertSupabase().storage).from('productos')
  const {data,error}=await bucket.upload(path,buffer,{upsert:false,contentType:'image/webp',cacheControl:'3600'})
  if(error||!data)throw Error('Sin confirmación')
  const imageUrl=bucket.getPublicUrl(path)?.data?.publicUrl
  if(!imageUrl)throw Error('Sin URL')
  return{imageUrl}
 }catch{throw Object.assign(new Error('No se pudo guardar la imagen. Intenta nuevamente.'),{status:503,code:'PACKAGE_IMAGE_UNAVAILABLE'})}
}
module.exports={MAX_IMAGE_BYTES,storePackageImage}
