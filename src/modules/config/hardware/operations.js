const {fail,uuid,ROLES}=require('./validation')
const has=(scope,code)=>scope.isAdmin||scope.permissions?.includes(code)
function operationScope(scope){
  if(!scope.companyId||!scope.actorId||!scope.branchId||scope.branchId==='all'||scope.isConsolidated)fail(400,'Selecciona una empresa y sucursal')
  return{company_id:scope.companyId,branch_id:scope.branchId}
}
function originPermission(scope,purpose){
  operationScope(scope)
  if(purpose==='RECEIPT'){
    if(!['sales.create','sales.view','sales.view_detail','sales.view_invoice'].some(p=>has(scope,p)))fail(403,'No tienes permiso para obtener este ticket')
  }else if(purpose==='LABEL'){
    if(!has(scope,'products.view')||!['products.export','reports.view'].some(p=>has(scope,p)))fail(403,'No tienes permiso para preparar etiquetas')
  }else fail(400,'Destino no válido')
}
async function resolveRoute(db,scope,{workstationId,cashRegisterId,role}){
  const tenant=operationScope(scope)
  if(workstationId)uuid(workstationId,'workstationId')
  if(cashRegisterId)uuid(cashRegisterId,'cashRegisterId')
  if(!workstationId&&!cashRegisterId)return null
  const station=await db.hardwareWorkstation.findFirst({where:{...tenant,state:'ACTIVE',...(workstationId?{id:workstationId}:{}),...(cashRegisterId?{cash_register_id:cashRegisterId}:{})}})
  if(!station)return null
  if(station.cash_register_id&&!await db.cashRegister.findFirst({where:{id:station.cash_register_id,branch_id:scope.branchId,active:true}}))return null
  const assignment=await db.hardwareAssignment.findFirst({where:{...tenant,workstation_id:station.id,role}})
  const device=assignment&&await db.hardwareDevice.findFirst({where:{...tenant,id:assignment.device_id,state:'ACTIVE',kind:ROLES[role]}})
  return{workstationId:station.id,version:station.version,cashRegisterId:station.cash_register_id,destination:device?{id:device.id,name:device.name,role,version:device.version,profile:device.profile}:null}
}
async function resolveWorkstation(db,scope,input){
  if(Object.keys(input).some(k=>!['workstationId','cashRegisterId','purpose'].includes(k)))fail(400,'Opción no admitida')
  originPermission(scope,input.purpose)
  return resolveRoute(db,scope,{...input,role:input.purpose})
}
module.exports={has,operationScope,originPermission,resolveRoute,resolveWorkstation}
