async function lockPrintBranding(tx){await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hardware-print-branding',0))`}
async function cleanupPrintLogo(db,url,remove){
 try{
  return await db.$transaction(async tx=>{
   await lockPrintBranding(tx)
   // Uploaded logos have unique, non-overwritten paths. Keep a historical asset while any print snapshot references it.
   const references=await tx.hardwarePrintJob.count({where:{snapshot:{path:['options','logoUrl'],equals:url}}})
   if(references)return undefined
   if(await remove(url)===false)throw Error('No eliminado')
  },{maxWait:10000,timeout:20000})
 }catch{return 'No se pudo limpiar un archivo de logo en Storage. La referencia confirmada se conserva.'}
}
module.exports={lockPrintBranding,cleanupPrintLogo}
