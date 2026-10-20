const {randomBytes,createHash,timingSafeEqual}=require('node:crypto')
const {fail,uuid}=require('../validation')
const {operationScope,has}=require('../operations')
const {canUseOrigin,databaseNow,drawerRoute,cashMovement}=require('./events')
const {readPolicy,ORIGINS}=require('./policy')
const tokenHash=token=>createHash('sha256').update(token).digest('hex')
const dto=row=>({id:row.id,origin:row.origin,sourceType:row.source_type,sourceId:row.source_id,workstationId:row.workstation_id,state:row.state,expiresAt:row.expires_at,mode:'SIMULATED'})
const transaction=(db,run)=>db.$transaction(run,{timeout:20000,maxWait:10000})
function allowed(scope,origin){operationScope(scope);if(!has(scope,'hardware.test_drawer')||!canUseOrigin(scope,origin))fail(403,'No tienes permiso para esta simulación')}
function strict(raw,keys){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))fail(400,'Datos de simulación no admitidos')}
async function own(tx,scope,id){
 uuid(id,'intentId');operationScope(scope)
 const row=await tx.hardwareDrawerIntent.findFirst({where:{id,company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId}})
 if(!row)fail(404,'Intención no encontrada')
 allowed(scope,row.origin)
 const movement=await cashMovement(tx,scope,{origin:row.origin,sourceId:row.source_id})
 if(!movement||movement.settlementKind!=='CASH'||movement.amount!==row.amount.toString()||movement.sessionId!==row.session_id)fail(409,'El movimiento ya no es elegible para simulación')
 return row
}
async function expire(tx,row,now){
 if(!['PENDING','CLAIMED'].includes(row.state))return false
 const attempt=row.state==='CLAIMED'?await tx.hardwareDrawerAttempt.findFirst({where:{intent_id:row.id}}):null
 if(now>=new Date(row.expires_at)||attempt&&now>=new Date(attempt.expires_at)){
  await tx.hardwareDrawerIntent.updateMany({where:{id:row.id,state:row.state},data:{state:'EXPIRED'}});row.state='EXPIRED';return true
 }
 return false
}
async function liveRoute(tx,scope,row){
 const policy=await readPolicy(tx,scope),route=await drawerRoute(tx,scope,row.session_id,row.workstation_id),before=row.route_snapshot
 if(!policy[ORIGINS[row.origin]]||policy.version!==row.policy_version||!route||route.version!==before.version||route.destination.id!==row.drawer_id||route.destination.version!==before.destination.version||route.printerId!==before.printerId||route.printerVersion!==before.printerVersion)fail(409,'El turno, la política o la ruta cambiaron. No se ejecutó ninguna apertura')
}
async function claimIntent(db,scope,raw){
 strict(raw,['intentId','workstationId','requestKey','mode']);uuid(raw.intentId,'intentId');uuid(raw.workstationId,'workstationId');uuid(raw.requestKey,'requestKey');if(raw.mode!=='SIMULATED')fail(400,'Solo se permite simulación; no hay conexión física')
 const result=await transaction(db,async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`drawer-intent:${raw.intentId}`},0))`
  const row=await own(tx,scope,raw.intentId),now=await databaseNow(tx)
  if(await expire(tx,row,now)||row.state!=='PENDING')return null
  if(row.workstation_id!==raw.workstationId)fail(403,'Esta intención pertenece a otro puesto')
  await liveRoute(tx,scope,row)
  const previous=await tx.hardwareDrawerAttempt.findFirst({where:{company_id:scope.companyId,actor_id:scope.actorId,request_key:raw.requestKey}})
  if(previous)return null
  const changed=await tx.$queryRaw`UPDATE hardware_drawer_intents SET state='CLAIMED',claimed_at=clock_timestamp() WHERE id=${row.id}::uuid AND state='PENDING' AND expires_at>clock_timestamp() RETURNING claimed_at,expires_at`
  if(changed.length!==1){await expire(tx,row,await databaseNow(tx));return null}
  const claimedAt=new Date(changed[0].claimed_at),token=randomBytes(32).toString('hex'),expiresAt=new Date(Math.min(claimedAt.getTime()+5000,new Date(changed[0].expires_at).getTime()))
  const attempt=await tx.hardwareDrawerAttempt.create({data:{intent_id:row.id,company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId,request_key:raw.requestKey,token_hash:tokenHash(token),expires_at:expiresAt,created_at:claimedAt}})
  return{attemptId:attempt.id,claimToken:token,expiresAt,mode:'SIMULATED'}
 })
 if(!result)fail(409,'La simulación ya fue reclamada o venció; no se volverá a enviar')
 return result
}
async function recordResult(db,scope,id,raw){
 strict(raw,['attemptId','claimToken','outcome']);uuid(raw.attemptId,'attemptId');if(typeof raw.claimToken!=='string'||!/^[a-f0-9]{64}$/.test(raw.claimToken)||!['SIMULATED','UNKNOWN'].includes(raw.outcome))fail(400,'Resultado de simulación no válido')
 const result=await transaction(db,async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`drawer-intent:${id}`},0))`
  const row=await own(tx,scope,id),now=await databaseNow(tx)
  const attempt=await tx.hardwareDrawerAttempt.findFirst({where:{id:raw.attemptId,intent_id:id,actor_id:scope.actorId,company_id:scope.companyId,branch_id:scope.branchId}})
  if(!attempt||!timingSafeEqual(Buffer.from(attempt.token_hash),Buffer.from(tokenHash(raw.claimToken))))fail(403,'La confirmación no pertenece a este intento')
  if(await expire(tx,row,now)||row.state==='EXPIRED')return null
  if(attempt.outcome){if(attempt.outcome!==raw.outcome)fail(409,'El resultado ya está registrado');return dto(row)}
  if(row.state!=='CLAIMED')return null
  await liveRoute(tx,scope,row)
  const changed=await tx.$queryRaw`UPDATE hardware_drawer_intents i SET state=${raw.outcome} FROM hardware_drawer_attempts a WHERE i.id=${id}::uuid AND a.id=${attempt.id}::uuid AND a.intent_id=i.id AND i.state='CLAIMED' AND a.outcome IS NULL AND i.expires_at>clock_timestamp() AND a.expires_at>clock_timestamp() RETURNING i.id`
  if(changed.length!==1){await expire(tx,row,await databaseNow(tx));return null}
  await tx.hardwareDrawerAttempt.updateMany({where:{id:attempt.id,outcome:null},data:{outcome:raw.outcome}})
  return dto({...row,state:raw.outcome})
 })
 if(!result)fail(409,'El intento venció; su resultado no se confirma ni se reintenta automáticamente')
 return result
}
async function listIntents(db,scope,raw){
 if(!has(scope,'hardware.test_drawer'))fail(403,'No tienes permiso para simular gavetas')
 strict(raw,['sourceType','sourceId']);if(!['SALE','CUSTOMER_PAYMENT','RETURN_SETTLEMENT'].includes(raw.sourceType))fail(400,'Origen no válido');uuid(raw.sourceId,'sourceId');operationScope(scope)
 return transaction(db,async tx=>{
  let sourceWhere={source_type:raw.sourceType,source_id:raw.sourceId}
  if(raw.sourceType==='SALE'){
   if(!canUseOrigin(scope,'POS_SALE'))fail(403,'No tienes permiso para esta operación')
   const sale=await tx.sale.findFirst({where:{id:raw.sourceId,branch_id:scope.branchId,branch:{company_id:scope.companyId},created_by:scope.actorId},select:{id:true}})
   if(!sale)fail(404,'Venta no encontrada')
   const receipts=await tx.customerPayment.findMany({where:{branch_id:scope.branchId,registered_by:scope.actorId,applications:{some:{sale_id:sale.id}}},select:{id:true}})
   sourceWhere={OR:[sourceWhere,{source_type:'CUSTOMER_PAYMENT',source_id:{in:receipts.map(r=>r.id)},origin:'INITIAL_CREDIT_RECEIPT'}]}
  }
  const rows=await tx.hardwareDrawerIntent.findMany({where:{company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId,...sourceWhere},take:10,orderBy:{created_at:'desc'}}),now=await databaseNow(tx),items=[]
  for(const row of rows){await own(tx,scope,row.id);await expire(tx,row,now);items.push(dto(row))}
  return{items,reason:items.length?null:'No hay una simulación disponible para este movimiento. Revisa política, efectivo, turno y ruta.'}
 })
}
module.exports={claimIntent,recordResult,listIntents}
