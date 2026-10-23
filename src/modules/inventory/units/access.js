const KEY = 'inventory_units_enabled'
const {parseQuantity}=require('../../../services/units/quantity')
// Deployed schema/client and integrated consumers verified; company opt-in stays explicit.
const UNITS_READY = true
function requestUnitScope(req) {
  const {hasPerm}=require('../../../middlewares/tenant')
  const user=req.user||{}
  return {companyId:req.companyId,branchId:req.branchId||null,actorId:user.sub||null,permissions:user.permissions||[],isAdmin:hasPerm({...user,permissions:[]},'products.view')}
}
function fail(status, message, code) { throw Object.assign(new Error(message), {status,...(code?{code}:{})}) }
function advancedProduct(product) {
  if(product?.base_unit_id&&![1,2].includes(product.unit_metadata_version))fail(409,'Recarga los datos completos de unidad del producto','UNIT_METADATA_REVIEW_REQUIRED')
  return product?.unit_metadata_version===2
}
function authorize(scope, permissions, write=false) {
  if (!scope?.companyId) fail(403,'Selecciona una empresa')
  if (!scope.isAdmin && !permissions.some(p=>scope.permissions?.includes(p))) fail(403,'No tienes permiso para esta operación')
  if (write && !scope.branchId) fail(400,'Selecciona una sucursal; el consolidado es solo de consulta')
}
async function unitsEnabled(db,companyId) {
  if (!companyId) return false
  const row=await require('../../../services/checkoutContext').checkoutSetting(db,companyId,KEY,()=>db.systemSetting?.findUnique?.({where:{company_id_key:{company_id:companyId,key:KEY}},select:{key:true,value:true}}))
  return row?.key===KEY&&String(row.value??'false').toLowerCase()==='true'
}
async function assertEnabled(db,scope) { if(!await unitsEnabled(db,scope.companyId)) fail(403,'Las unidades y presentaciones están desactivadas') }
async function lockCompany(tx,companyId) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-units:${companyId}`},0))` }
async function lockProduct(tx,scope,id) {
  const cached=require('../../../services/checkoutContext').checkoutProducts(tx,[id],scope)?.get(String(id))
  if(cached){if(cached.deleted)fail(404,'Producto no encontrado');return cached}
  await tx.$executeRaw`SELECT id FROM products WHERE id=${id}::uuid AND company_id=${scope.companyId}::uuid FOR UPDATE`
  return scopedProduct(tx,scope,id)
}
async function scopedProduct(tx,scope,id) {
  const product=await tx.product.findFirst({where:{id,company_id:scope.companyId,deleted:false}})
  if (!product) fail(404,'Producto no encontrado')
  return product
}
function revision(product,expected) { if(!Number.isSafeInteger(expected)||expected!==product.unit_revision) fail(409,'La configuración de unidades cambió; recarga el producto','UNIT_REVISION_CONFLICT') }
async function bumpRevision(tx,product,data={}) {
  const claim=await tx.product.updateMany({where:{id:product.id,company_id:product.company_id,unit_revision:product.unit_revision},data:{...data,unit_revision:product.unit_revision+1}})
  if(claim.count!==1)fail(409,'La configuración de unidades cambió; recarga el producto','UNIT_REVISION_CONFLICT')
  return tx.product.findFirst({where:{id:product.id,company_id:product.company_id}})
}
function objectInput(input,keys) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))fail(400,'La solicitud contiene campos no admitidos')
}
function text(raw,name,max) { if(typeof raw!=='string'||!raw.trim()||raw.trim().length>max)fail(400,`${name} inválido`);return raw.trim() }
function decimals(raw,max=6) { if(!Number.isInteger(raw)||raw<0||raw>max)fail(400,'Precisión de cantidad inválida');return raw }
const factorText=raw=>parseQuantity(raw,{decimals:12,max:'99999999.999999999999'}).toFixed()
module.exports={KEY,UNITS_READY,advancedProduct,requestUnitScope,fail,authorize,unitsEnabled,assertEnabled,lockCompany,lockProduct,scopedProduct,revision,bumpRevision,objectInput,text,decimals,factorText}
