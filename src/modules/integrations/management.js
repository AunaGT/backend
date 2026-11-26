const {randomUUID}=require('node:crypto')
const {performance}=require('node:perf_hooks')
const {parseCreateInput,pageQuery,issueCredential,fail,uuid,object,isExpired}=require('./credentials')
const {credentialState}=require('./credentialState')
const {parseCredentialQuery}=require('./managementQuery')
const {authorizeManagement,loadIntegrationPrincipal,assertScopeAccess}=require('./policy')
const include={owner:{select:{user:{select:{id:true,name:true}}}},customerPaymentTerm:{select:{name:true}},branches:{include:{branch:{select:{id:true,name:true}}}}}
const iso=v=>v?new Date(v).toISOString():null
function summary(row,now){return{id:row.id,name:row.name,publicId:row.public_id,integrationId:row.integration_id,customerPolicy:row.customer_policy,customerPaymentTermId:row.customer_payment_term_id,customerPaymentTermName:row.customerPaymentTerm?.name??null,owner:{id:row.owner_id,name:row.owner?.user?.name||''},scopes:row.scopes,branches:row.branches.map(r=>({id:r.branch_id,name:r.branch?.name||''})),createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),revokedAt:iso(row.revoked_at),pausedAt:iso(row.paused_at),lastUsedAt:iso(row.last_used_at),replacesId:row.replaces_id||null,status:credentialState(row,now)}}
async function owned(db,scope,id){if(!uuid(id))fail(404,'NOT_FOUND');const row=await db.integrationCredential.findFirst({where:{id,company_id:scope.companyId},include});if(!row)fail(404,'NOT_FOUND');return row}
const audit=(tx,scope,id,action,now,metadata={})=>tx.integrationAuditEvent.create({data:{id:randomUUID(),company_id:scope.companyId,credential_id:id,actor_id:scope.actorId,action,metadata,created_at:now}})
function movingClock(now){const start=performance.now();return()=>new Date(now.getTime()+Math.floor(performance.now()-start))}
async function lockCredential(tx,scope,id){
 if(!uuid(id))fail(404,'NOT_FOUND')
 // Serialize administration without blocking company FK KEY SHARE in API audits.
 await tx.$executeRaw`SELECT id FROM companies WHERE id=${scope.companyId}::uuid FOR NO KEY UPDATE`
 await tx.$executeRaw`SELECT id FROM integration_credentials WHERE id=${id}::uuid AND company_id=${scope.companyId}::uuid FOR UPDATE`
 return owned(tx,scope,id)
}
async function currentManager(tx,scope,now){
 const actor=await loadIntegrationPrincipal(tx,{companyId:scope.companyId,ownerId:scope.actorId},now)
 authorizeManagement({...scope,isAdmin:actor.isAdmin,permissions:actor.permissions},'manage')
 if(!actor.branches.some(b=>b.id===scope.branchId))fail(403,'FORBIDDEN')
 return actor
}
async function create(tx,scope,raw,now,replacesId=null){
 const input=parseCreateInput(raw),clock=movingClock(now)
 await tx.$executeRaw`SELECT id FROM companies WHERE id=${scope.companyId}::uuid FOR NO KEY UPDATE`
 const prev=replacesId?await lockCredential(tx,scope,replacesId):null
 const [actor,owner]=await Promise.all([currentManager(tx,scope,clock()),loadIntegrationPrincipal(tx,{companyId:scope.companyId,ownerId:input.ownerId},clock())])
 assertScopeAccess(actor,input.scopes,input.branchIds);assertScopeAccess(owner,input.scopes,input.branchIds)
 if(input.customerPolicy==='CREATE_IF_MISSING'&&!await tx.paymentTerm.findFirst({where:{id:input.customerPaymentTermId,company_id:scope.companyId,deleted:false},select:{id:true}}))fail(403,'FORBIDDEN')
 if(await tx.integrationCredential.count({where:{company_id:scope.companyId,revoked_at:null,OR:[{expires_at:null},{expires_at:{gt:clock()}}]}})>=20)fail(409,'KEY_LIMIT')
 let integrationId
 if(replacesId){if(prev.revoked_at||prev.owner_id!==input.ownerId||input.scopes.some(s=>!prev.scopes.includes(s))||input.branchIds.some(id=>!prev.branches.some(b=>b.branch_id===id))||input.customerPolicy==='CREATE_IF_MISSING'&&(prev.customer_policy!=='CREATE_IF_MISSING'||prev.customer_payment_term_id!==input.customerPaymentTermId))fail(403,'FORBIDDEN');integrationId=prev.integration_id}
 else{integrationId=randomUUID();await tx.integrationIdentity.create({data:{id:integrationId,company_id:scope.companyId,created_at:now}})}
 const secret=issueCredential(),row=await tx.integrationCredential.create({data:{id:randomUUID(),company_id:scope.companyId,integration_id:integrationId,customer_policy:input.customerPolicy,customer_payment_term_id:input.customerPaymentTermId,owner_id:input.ownerId,created_by:scope.actorId,name:input.name,public_id:secret.publicId,secret_hash:secret.secretHash,scopes:input.scopes,paused_at:prev?.paused_at??null,expires_at:input.days===null?null:new Date(now.getTime()+input.days*86400000),created_at:now,replaces_id:replacesId,branches:{create:input.branchIds.map(id=>({branch_id:id}))}},include})
 await audit(tx,scope,row.id,replacesId?'REPLACE':'CREATE',now,{scopes:input.scopes,branchIds:input.branchIds,replacesId})
 return{credential:summary(row,now),apiKey:secret.apiKey}
}
function createCredential(db,scope,input,now=new Date()){authorizeManagement(scope,'manage');return db.$transaction(tx=>create(tx,scope,input,now))}
function replaceCredential(db,scope,id,input,now=new Date()){authorizeManagement(scope,'manage');return db.$transaction(tx=>create(tx,scope,input,now,id))}
async function revokeCredential(db,scope,id,now=new Date()){
 authorizeManagement(scope,'manage')
 const clock=movingClock(now)
 return db.$transaction(async tx=>{const row=await lockCredential(tx,scope,id);await currentManager(tx,scope,clock());const at=clock();const changed=await tx.integrationCredential.updateMany({where:{company_id:scope.companyId,id,revoked_at:null},data:{revoked_at:at}});if(changed.count)await audit(tx,scope,id,'REVOKE',at);return summary({...row,revoked_at:row.revoked_at||at},at)})
}
async function setPaused(db,scope,id,paused,now){
 authorizeManagement(scope,'manage');const clock=movingClock(now)
 return db.$transaction(async tx=>{
  const row=await lockCredential(tx,scope,id);await currentManager(tx,scope,clock())
  if(!paused){const principal=await loadIntegrationPrincipal(tx,{companyId:scope.companyId,ownerId:row.owner_id},clock());assertScopeAccess(principal,row.scopes,row.branches.map(b=>b.branch_id))}
  const at=clock();if(row.revoked_at||isExpired(row.expires_at,at))fail(409,'CREDENTIAL_STATE_CONFLICT')
  if(Boolean(row.paused_at)===paused)return summary(row,at)
  const paused_at=paused?at:null
  await tx.integrationCredential.updateMany({where:{id,company_id:scope.companyId,revoked_at:null},data:{paused_at}})
  await audit(tx,scope,id,paused?'PAUSE':'RESUME',at)
  return summary({...row,paused_at},at)
 })
}
const pauseCredential=(db,scope,id,now=new Date())=>setPaused(db,scope,id,true,now)
const resumeCredential=(db,scope,id,now=new Date())=>setPaused(db,scope,id,false,now)
async function getCredential(db,scope,id,now=new Date()){authorizeManagement(scope);return summary(await owned(db,scope,id),now)}
async function listCredentials(db,scope,query={},now=new Date()){
 authorizeManagement(scope);const {page,pageSize,where:filters}=parseCredentialQuery(query,now),where={company_id:scope.companyId,...filters}
 const [rows,total]=await Promise.all([db.integrationCredential.findMany({where,include,orderBy:[{created_at:'desc'},{id:'desc'}],skip:(page-1)*pageSize,take:pageSize}),db.integrationCredential.count({where})])
 return{items:rows.map(r=>summary(r,now)),total,page,pageSize}
}
async function getManagementOptions(db,scope,query={},now=new Date()){
 authorizeManagement(scope,'manage');const {page,pageSize}=pageQuery(query),where={company_id:scope.companyId,status:'ACTIVE',company:{active:true}}
 const actor=await loadIntegrationPrincipal(db,{companyId:scope.companyId,ownerId:scope.actorId},now)
 const rows=await db.userCompany.findMany({where,select:{user_id:true,user:{select:{id:true,name:true}}},orderBy:{user_id:'asc'},skip:(page-1)*pageSize,take:pageSize+1})
 return{owners:rows.slice(0,pageSize).map(r=>({id:r.user_id,name:r.user.name})),hasMore:rows.length>pageSize,page,branches:actor.branches,scopes:require('./policy').effectiveScopes(actor,require('./credentials').SCOPES),limits:{defaultDays:90,maxDays:365,maxKeys:20,allowNoExpiry:true}}
}
async function listCredentialAudit(db,scope,id,query={}){
 authorizeManagement(scope);await owned(db,scope,id);const {page,pageSize}=pageQuery(query),where={company_id:scope.companyId,credential_id:id}
 const [items,total]=await Promise.all([db.integrationAuditEvent.findMany({where,select:{id:true,action:true,actor_id:true,route:true,status:true,branch_id:true,created_at:true,request_id:true},orderBy:[{created_at:'desc'},{id:'desc'}],skip:(page-1)*pageSize,take:pageSize}),db.integrationAuditEvent.count({where})]);return{items,total,page,pageSize}
}
async function getCustomerPaymentTerms(db,scope,query={},now=new Date()){
 authorizeManagement(scope,'manage');object(query,['page','pageSize','q'])
 const {page,pageSize}=pageQuery({page:query.page,pageSize:query.pageSize??25})
 if(query.q!==undefined&&(typeof query.q!=='string'||query.q.length>100))fail(400)
 const actor=await loadIntegrationPrincipal(db,{companyId:scope.companyId,ownerId:scope.actorId},now)
 assertScopeAccess(actor,['customers.create'],[])
 const rows=await db.paymentTerm.findMany({where:{company_id:scope.companyId,deleted:false,...(query.q?{name:{contains:query.q.trim(),mode:'insensitive'}}:{})},select:{id:true,name:true},orderBy:{id:'asc'},skip:(page-1)*pageSize,take:pageSize+1})
 return{items:rows.slice(0,pageSize),page,hasMore:rows.length>pageSize}
}
module.exports={createCredential,replaceCredential,revokeCredential,pauseCredential,resumeCredential,listCredentials,getCredential,getManagementOptions,listCredentialAudit,getCustomerPaymentTerms,summary}
