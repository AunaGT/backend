const {hasPerm,requireCompany}=require('../../../middlewares/tenant')
const {resolveEffectiveModules}=require('../../platform/registry')
function error(status,code,message,productId){throw Object.assign(new Error(message),{status,code,...(productId?{productId}:{})})}
function barcodeScope(req){
  if(!req.user?.sub)error(401,'UNAUTHENTICATED','Inicia sesión')
  if(!hasPerm(req.user,'products.view'))error(403,'FORBIDDEN','Necesitas permiso para ver productos')
  return{companyId:requireCompany(req),userId:req.user.sub,branchId:req.branchId||null,branchIds:[...(req.branchIds||req.userBranchIds||[req.branchId]).filter(Boolean)],isAdmin:hasPerm({...req.user,permissions:[]},'products.view'),permissions:[...(req.user.permissions||[])]}
}
const has=(scope,code)=>scope.isAdmin||scope.permissions.includes(code)
async function assertAccess(db,scope,{write=false,assign=false,save=false}={}){
  if(!has(scope,'products.view')||write&&!has(scope,'products.export')&&!has(scope,'reports.view')||assign&&!has(scope,'products.edit')||save&&!has(scope,'settings.manage'))error(403,'FORBIDDEN','No tienes permiso para esta operación')
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(!modules.some(m=>m.code==='inventory'&&m.effectiveEnabled))error(403,'MODULE_DISABLED','Inventario no está habilitado')
}
async function authorizedScope(db,scope,filter,write=false){
  const branchId=filter.branchId||scope.branchId
  if(write&&!scope.branchId)error(400,'BRANCH_REQUIRED','Selecciona una sucursal para preparar la impresión')
  if(branchId&&(write&&branchId!==scope.branchId||!scope.branchIds.includes(branchId)))error(403,'FORBIDDEN','Sin acceso a esa sucursal')
  if(branchId&&!await db.branch.findFirst({where:{id:branchId,company_id:scope.companyId,active:true}}))error(403,'FORBIDDEN','Sucursal no disponible')
  if(filter.warehouseId&&!await db.warehouse.findFirst({where:{id:filter.warehouseId,branch:{company_id:scope.companyId,id:branchId||{in:scope.branchIds},active:true}}}))error(403,'FORBIDDEN','Almacén fuera del alcance')
  if(filter.locationId&&!await db.stockLocation.findFirst({where:{id:filter.locationId,...(filter.warehouseId?{warehouse_id:filter.warehouseId}:{}),warehouse:{branch:{company_id:scope.companyId,id:branchId||{in:scope.branchIds},active:true}}}}))error(403,'FORBIDDEN','Ubicación fuera del alcance')
  return{branchId,warehouseId:filter.warehouseId,locationId:filter.locationId,inBranch:filter.inBranch===true}
}
function productWhere(scope,filter){
  const where={company_id:scope.companyId,deleted:false,available_for_sale:true,kind:{not:'SERVICE'}}
  if(filter.inBranch)where.branch_stocks={some:{branch_id:filter.branchId||{in:scope.branchIds}}}
  if(filter.warehouseId||filter.locationId)where.location_stocks={some:{stock:{not:0},...(filter.locationId?{location_id:filter.locationId}:{}),location:{warehouse:{...(filter.warehouseId?{id:filter.warehouseId}:{}),branch_id:filter.branchId||{in:scope.branchIds},branch:{company_id:scope.companyId}}}}}
  return where
}
module.exports={barcodeScope,assertAccess,authorizedScope,productWhere,has,error}
