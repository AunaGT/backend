const {Prisma}=require('@prisma/client')
const {fail}=require('../validation')
const {has,operationScope}=require('../operations')
const KEYS=['posCashSale','initialCreditReceipt','receivableReceipt','agendaReceipt','cashReturn']
const ORIGINS={POS_SALE:'posCashSale',INITIAL_CREDIT_RECEIPT:'initialCreditReceipt',RECEIVABLE_RECEIPT:'receivableReceipt',AGENDA_RECEIPT:'agendaReceipt',CASH_RETURN:'cashReturn'}
const DEFAULT_POLICY={version:0,posCashSale:true,initialCreditReceipt:false,receivableReceipt:false,agendaReceipt:false,cashReturn:false}
function validateDrawerPolicy(raw){
 if(!raw||Array.isArray(raw)||typeof raw!=='object'||Object.keys(raw).some(k=>!['expectedVersion',...KEYS].includes(k))||KEYS.some(k=>typeof raw[k]!=='boolean')||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<0)fail(400,'Revisa la política de simulación')
 return raw
}
function drawerEligibility({policy,origin,settlementKind,amount,sessionOpen,routeActive}){
 if(!ORIGINS[origin]||!policy[ORIGINS[origin]])return{eligible:false,reason:'POLICY_DISABLED'}
 let positive=false;try{positive=new Prisma.Decimal(amount).isFinite()&&new Prisma.Decimal(amount).gt(0)}catch{/* An invalid amount cannot authorize a simulation. */}
 if(settlementKind!=='CASH'||!positive)return{eligible:false,reason:'NOT_POSITIVE_CASH'}
 if(!sessionOpen)return{eligible:false,reason:'SESSION_UNAVAILABLE'}
 if(!routeActive)return{eligible:false,reason:'ROUTE_UNAVAILABLE'}
 return{eligible:true,reason:'ELIGIBLE'}
}
async function readPolicy(db,scope,administrative=false){
 if(!scope.companyId)fail(400,'Selecciona una empresa')
 if(administrative&&!has(scope,'hardware.view'))fail(403,'No tienes permiso para consultar esta política')
 const row=await db.hardwareDrawerPolicy.findFirst({where:{company_id:scope.companyId}})
 return row?{version:row.version,...row.policy}:{...DEFAULT_POLICY}
}
async function savePolicy(db,scope,raw){
 operationScope(scope);if(!has(scope,'hardware.manage'))fail(403,'No tienes permiso para cambiar esta política')
 const input=validateDrawerPolicy(raw)
 return db.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`drawer-policy:${scope.companyId}`},0))`
  const before=await readPolicy(tx,scope),policy=Object.fromEntries(KEYS.map(k=>[k,input[k]]))
  if(before.version!==input.expectedVersion)fail(409,'Otra persona cambió esta política. Actualiza antes de guardar')
  if(before.version)await tx.hardwareDrawerPolicy.updateMany({where:{company_id:scope.companyId,version:before.version},data:{policy,version:{increment:1}}})
  else await tx.hardwareDrawerPolicy.create({data:{company_id:scope.companyId,version:1,policy}})
  const after={version:before.version+1,...policy}
  await tx.hardwareAuditEvent.create({data:{company_id:scope.companyId,branch_id:scope.branchId,actor_id:scope.actorId,action:'DRAWER_POLICY_UPDATED',entity_id:scope.companyId,before,after}})
  return after
 },{timeout:20000,maxWait:10000})
}
module.exports={DEFAULT_POLICY,ORIGINS,validateDrawerPolicy,drawerEligibility,readPolicy,savePolicy}
