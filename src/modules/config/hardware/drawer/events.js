const {has,operationScope,resolveRoute}=require('../operations')
const {readPolicy,drawerEligibility,ORIGINS}=require('./policy')
const {hasPerm}=require('../../../../middlewares/tenant')
const permissionFor={POS_SALE:['sales.create'],INITIAL_CREDIT_RECEIPT:['sales.create'],RECEIVABLE_RECEIPT:['receivables.manage'],AGENDA_RECEIPT:['appointments.collect','receivables.manage'],CASH_RETURN:['returns.manage']}
function canUseOrigin(scope,origin){return !!permissionFor[origin]&&permissionFor[origin].every(p=>has(scope,p))}
function requestHardwareScope(req){return{companyId:req.companyId,branchId:req.branchId,actorId:req.user?.sub,permissions:req.user?.permissions||[],isAdmin:hasPerm({...req.user,permissions:[]},'hardware.view')}}
async function databaseNow(tx){const rows=await tx.$queryRaw`SELECT clock_timestamp() AS now`;return new Date(rows[0].now)}
async function cashMovement(tx,scope,{origin,sourceId}){
 let row,sourceType,amount,actorId,sessionId,method,branchId
 if(origin==='POS_SALE'){
  row=await tx.sale.findFirst({where:{id:sourceId,branch_id:scope.branchId,branch:{company_id:scope.companyId}},include:{payment_method:true}})
  if(!row||row.sales_channel!=='POS'||row.payment_method?.is_credit||row.settlement_source==='ENGAGEMENT_RECEIPTS')return null
  sourceType='SALE';amount=row.total;actorId=row.created_by;sessionId=row.cash_register_session_id;method=row.payment_method;branchId=row.branch_id
 }else if(['INITIAL_CREDIT_RECEIPT','RECEIVABLE_RECEIPT','AGENDA_RECEIPT'].includes(origin)){
  row=await tx.customerPayment.findFirst({where:{id:sourceId,branch_id:scope.branchId,branch:{company_id:scope.companyId}},include:{payment_method:true}})
  if(!row||row.kind!=='PAYMENT')return null
  sourceType='CUSTOMER_PAYMENT';amount=row.amount;actorId=row.registered_by;sessionId=row.cash_register_session_id;method=row.payment_method;branchId=row.branch_id
 }else if(origin==='CASH_RETURN'){
  row=await tx.returnSettlement.findFirst({where:{id:sourceId,return:{sale:{branch_id:scope.branchId,branch:{company_id:scope.companyId}}}},include:{payment_method:true,return:{select:{sale:{select:{branch_id:true}}}}}})
  if(!row||row.kind!=='REFUND')return null
  sourceType='RETURN_SETTLEMENT';amount=row.amount;actorId=row.registered_by;sessionId=row.cash_register_session_id;method=row.payment_method;branchId=row.return.sale.branch_id
 }
 if(!row||actorId!==scope.actorId||branchId!==scope.branchId)return null
 return{sourceType,amount:amount.toString(),sessionId,settlementKind:method?.settlement_kind}
}
async function drawerRoute(tx,scope,sessionId,workstationId){
 if(!sessionId)return null
 const session=await tx.cashRegisterSession.findFirst({where:{id:sessionId,status:'OPEN',cashRegister:{branch_id:scope.branchId,active:true}}})
 if(!session||!scope.isAdmin&&session.opened_by_id!==scope.actorId)return null
 const route=await resolveRoute(tx,scope,{workstationId,cashRegisterId:session.cash_register_id,role:'DRAWER'})
 if(!route?.destination)return null
 const printer=await resolveRoute(tx,scope,{workstationId:route.workstationId,cashRegisterId:session.cash_register_id,role:'RECEIPT'})
 if(!printer?.destination||route.destination.profile.parentPrinterId!==printer.destination.id)return null
 return{...route,sessionId,printerId:printer.destination.id,printerVersion:printer.destination.version}
}
async function enqueueDrawerIntent(tx,scope,input){
 const skip=reason=>({intentId:null,reason})
 if(!scope.companyId||!scope.branchId||!scope.actorId||!ORIGINS[input.origin]||!canUseOrigin(scope,input.origin))return skip('ORIGIN_UNAVAILABLE')
 const movement=await cashMovement(tx,scope,input)
 if(!movement||movement.settlementKind!=='CASH')return skip('NOT_CASH')
 const policy=await readPolicy(tx,scope),first=drawerEligibility({policy,origin:input.origin,settlementKind:movement.settlementKind,amount:movement.amount,sessionOpen:true,routeActive:true})
 if(!first.eligible)return skip(first.reason)
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hardware:${scope.companyId}:${scope.branchId}`},0))`
 await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id=${movement.sessionId}::uuid FOR SHARE`
 if(input.workstationId&&!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.workstationId))return skip('ROUTE_UNAVAILABLE')
 const route=await drawerRoute(tx,scope,movement.sessionId,input.workstationId)
 if(!route)return skip('ROUTE_UNAVAILABLE')
 const identity={company_id:scope.companyId,source_type:movement.sourceType,source_id:input.sourceId,drawer_id:route.destination.id}
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`drawer-source:${scope.companyId}:${movement.sourceType}:${input.sourceId}`},0))`
 const previous=await tx.hardwareDrawerIntent.findFirst({where:identity})
 if(previous)return{intentId:previous.id,reason:'ALREADY_RECORDED'}
 const now=await databaseNow(tx)
 const row=await tx.hardwareDrawerIntent.create({data:{...identity,branch_id:scope.branchId,actor_id:scope.actorId,origin:input.origin,amount:movement.amount,session_id:movement.sessionId,workstation_id:route.workstationId,route_snapshot:route,policy_version:policy.version,state:'PENDING',created_at:now,expires_at:new Date(now.getTime()+30000)}})
 return{intentId:row.id,reason:'SIMULATION_AVAILABLE'}
}
module.exports={canUseOrigin,requestHardwareScope,databaseNow,cashMovement,drawerRoute,enqueueDrawerIntent}
