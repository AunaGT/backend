const {randomUUID}=require('node:crypto')
async function recordUsageInTransaction(tx,context,{route,status,branchId,requestId},now=new Date()){
  await tx.integrationAuditEvent.create({data:{id:randomUUID(),company_id:context.companyId,credential_id:context.credentialId,action:'USE',route,status,branch_id:branchId||null,request_id:requestId,created_at:now}})
  if(status<400)await tx.integrationCredential.updateMany({where:{id:context.credentialId,company_id:context.companyId},data:{last_used_at:now}})
}
async function recordUsage(db,context,event,now=new Date()){await db.$transaction(tx=>recordUsageInTransaction(tx,context,event,now))}
async function recordDraftCreation(tx,context,{documentId,type,branchId,requestId},now=new Date()){
 await tx.integrationAuditEvent.create({data:{id:randomUUID(),company_id:context.companyId,credential_id:context.credentialId,action:'CREATE_DRAFT',route:type==='QUOTE'?'/quotes':'/orders',status:201,branch_id:branchId,request_id:requestId??null,metadata:{documentId,type},created_at:now}})
 await tx.integrationCredential.updateMany({where:{id:context.credentialId,company_id:context.companyId},data:{last_used_at:now}})
}
async function recordDraftMutation(tx,context,{documentId,type,action,branchId,requestId},now=new Date()){
 await tx.integrationAuditEvent.create({data:{id:randomUUID(),company_id:context.companyId,credential_id:context.credentialId,action,route:(type==='QUOTE'?'/quotes/:id':'/orders/:id')+(action==='CANCEL_DRAFT'?'/cancel':''),status:200,branch_id:branchId,request_id:requestId??null,metadata:{documentId,type},created_at:now}})
 await tx.integrationCredential.updateMany({where:{id:context.credentialId,company_id:context.companyId},data:{last_used_at:now}})
}
async function cleanupIntegrationHistory(db,{limit=500,now=new Date()}={}){
 if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Invalid cleanup limit')
 const usage=new Date(now.getTime()-30*86400000),admin=new Date(now.getTime()-365*86400000),windows=new Date(now.getTime()-120000)
 const events=await db.$executeRaw`DELETE FROM integration_audit_events WHERE id IN (
  SELECT id FROM integration_audit_events WHERE (action='USE' AND created_at<${usage}) OR (action<>'USE' AND created_at<${admin}) ORDER BY created_at,id LIMIT ${limit})`
 const quotas=await db.$executeRaw`DELETE FROM integration_rate_windows WHERE (bucket,window_at) IN (
  SELECT bucket,window_at FROM integration_rate_windows WHERE window_at<${windows} ORDER BY window_at,bucket LIMIT ${limit})`
 return{events,quotas}
}
module.exports={recordUsage,recordUsageInTransaction,recordDraftCreation,recordDraftMutation,cleanupIntegrationHistory}
