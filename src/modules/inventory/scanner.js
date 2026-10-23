const {hasPerm}=require('../../middlewares/tenant')
const {catalogItemsDTO}=require('./posCatalog')
const {assertServicesEnabled}=require('../../services/catalogItemRules')
const fail=(status,message)=>{throw Object.assign(Error(message),{status})}
function scanInput(scope,raw){
 if(!scope.companyId||!scope.branchId||scope.branchId==='all')fail(400,'Selecciona una sucursal')
 const permission={SALE:'sales.create',PURCHASE:'products.register_incoming',LOOKUP:'products.view'}[raw.operation]
 if(!permission)fail(400,'Operación de lectura inválida')
 if(!hasPerm(scope.user,permission))fail(403,'No tienes permiso para esta acción')
 if(typeof raw.code!=='string'||!raw.code.length||raw.code.length>100||/[\x00-\x1f\x7f]/.test(raw.code))fail(400,'Ingresa un código válido de hasta 100 caracteres')
 return raw.code
}
async function resolveScan(db,scope,raw){
 const code=scanInput(scope,raw)
 if(!await db.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId,active:true},select:{id:true}}))fail(404,'Sucursal no disponible')
 const registered=await db.productBarcode.findFirst({where:{company_id:scope.companyId,code,active:true},select:{product_id:true,presentation_id:true}})
 const keys=['id','name','brand','size','barcode','image_url','kind','available_for_sale','category_id','base_unit_id','unit_metadata_version','quantity_decimals','unit_revision','default_sale_presentation_id','default_purchase_presentation_id','price','price_wholesale','price_promotion','promotion_valid_until','stock','min_stock','service_unit_label','tracks_expiry',...(raw.operation==='PURCHASE'?['cost']:[])]
 const rows=await db.product.findMany({where:{company_id:scope.companyId,deleted:false,OR:[{barcode:code},...(registered?[{id:registered.product_id}]:[])]},select:{...Object.fromEntries(keys.map(k=>[k,true])),category:{select:{id:true,name:true}}},take:3})
 if(rows.length>1)fail(409,'El código corresponde a varios productos. Revisa su asignación.')
 const product=rows[0];if(!product)fail(404,'No encontramos este código. Puedes buscar el producto manualmente.')
 if(raw.operation==='SALE'&&product.available_for_sale===false)fail(409,'Este producto no está disponible para la venta')
 if(product.kind==='SERVICE'){if(raw.operation==='PURCHASE')fail(409,'El ingreso de mercancía requiere un bien');await assertServicesEnabled(db,scope.companyId)}
 const presentationId=registered?.presentation_id??null
 if(presentationId){
  const p=await db.productPresentation.findFirst({where:{id:presentationId,company_id:scope.companyId,product_id:product.id,active:true}})
  if(!p||raw.operation!=='LOOKUP'&&!(raw.operation==='PURCHASE'?p.purchase_enabled:p.sale_enabled))fail(409,'La presentación no está habilitada para esta operación')
 }
 const [dto]=await catalogItemsDTO(db,scope,[product])
 return {product:{...dto,tracks_expiry:product.tracks_expiry,...(raw.operation==='PURCHASE'?{cost:product.cost}: {})},presentationId,unitRevision:product.unit_revision??1}
}
async function scannerProfile(db,scope,input){
 if(!['products.view','sales.create','products.register_incoming','inventory_count.count'].some(p=>hasPerm(scope.user,p)))fail(403,'No tienes permiso para leer productos')
 if(!input.workstationId)return null
 const {resolveRoute}=require('../config/hardware/operations')
 const route=await resolveRoute(db,{companyId:scope.companyId,branchId:scope.branchId,actorId:scope.user.sub},{workstationId:input.workstationId,role:'SCANNER'})
 return route?.destination?{name:route.destination.name,profile:route.destination.profile}:null
}
module.exports={resolveScan,scannerProfile}
