const crypto=require('crypto')
const Units=require('../modules/inventory/units')
const {parseQuantity}=require('./units/quantity')
const {decimal,physicalQuantity,physicalSnapshot,lockPhysicalProducts}=require('./units/physical')
const {deductStockMap,restoreStockMap}=require('./bomStock')
const {defaultLocationId}=require('./stockLocations')
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
const amount=value=>parseQuantity(value??'0',{decimals:2,allowZero:true,max:'9999999999.99'})
const id=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))fail('Selecciona un producto válido');return value}
function fields(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('La entrada contiene campos no admitidos para este origen')}

async function registerOwnReceipt(tx,scope,input){
  fields(input,['source','request_key','items','components','costs','notes','location_id'])
  if(!['INITIAL','PRODUCTION'].includes(input.source))fail('Selecciona el origen de la entrada')
  if(!scope.companyId||!scope.branchId||!scope.userId)fail('Selecciona una empresa y sucursal válidas',403)
  if(!await tx.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId,active:true}}))fail('Sucursal no disponible',403)
  if(typeof input.request_key!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(input.request_key))fail('La entrada necesita una clave de solicitud válida')
  if(input.notes!=null&&(typeof input.notes!=='string'||input.notes.length>4000))fail('Las observaciones admiten hasta 4000 caracteres')
  await Units.lockCompany(tx,scope.companyId)
  const hash=crypto.createHash('sha256').update(JSON.stringify(canonical({branchId:scope.branchId,input}))).digest('hex')
  const previous=await tx.incomingMerchandise.findFirst({where:{request_company_id:scope.companyId,registered_by:scope.userId,request_key:input.request_key}})
  if(previous){if(previous.request_hash!==hash)fail('La solicitud ya se utilizó con otros datos',409);if(!previous.request_result)fail('La entrada aún se está confirmando',409);return previous.request_result}
  const production=input.source==='PRODUCTION',components=input.components??[],costs=input.costs??{}
  if(!Array.isArray(input.items)||!input.items.length||input.items.length>100||production&&input.items.length!==1)fail('Selecciona un producto terminado para fabricar, o de 1 a 100 productos de apertura')
  if(!Array.isArray(components)||components.length>100||!production&&(components.length||Object.keys(costs).length))fail('Los materiales y costos de fabricación solo aplican a producción')
  fields(costs,['materials','labor','other'])
  const manual={materials:amount(costs.materials),labor:amount(costs.labor),other:amount(costs.other)}
  for(const row of input.items){fields(row,['product_id','quantity','unit_cost','unit_revision','lot_code','expiry_date']);id(row.product_id)}
  for(const row of components){fields(row,['product_id','quantity','unit_revision']);id(row.product_id)}
  const outputIds=input.items.map(row=>row.product_id),componentIds=components.map(row=>row.product_id)
  if(new Set(outputIds).size!==outputIds.length||new Set(componentIds).size!==componentIds.length||componentIds.some(pid=>outputIds.includes(pid)))fail('No repitas productos ni uses el producto terminado como su propio material')
  const products=await lockPhysicalProducts(tx,[...outputIds,...componentIds],scope.branchId)
  for(const pid of [...outputIds,...componentIds]){
    const p=products.get(pid)
    if(!p||p.company_id!==scope.companyId||p.deleted)fail('Producto no disponible en esta empresa',404)
    if(p.kind!=='STANDARD')fail('Usa bienes físicos; los servicios no tienen stock y los kits tienen su propio armado')
  }
  const checked=(row)=>{const p=products.get(row.product_id);if(row.unit_revision!=null&&row.unit_revision!==p.unit_revision)fail('La unidad cambió; recarga el producto',409);return physicalQuantity(String(row.quantity),p).toFixed()}
  const deductions=new Map(),materialRows=[]
  let tracked=decimal(0)
  for(const row of components){
    const product=products.get(row.product_id),quantity=checked(row),value=decimal(quantity).mul(product.cost)
    deductions.set(product.id,quantity);tracked=tracked.add(value)
    materialRows.push({product_id:product.id,name:product.name,quantity,unit_cost:decimal(product.cost).toFixed(12),value:value.toFixed(2)})
  }
  if(deductions.size){
    const available=await require('./stockAvailability').getAvailabilityBatch([...deductions.keys()],tx,{branchId:scope.branchId})
    for(const [pid,quantity]of deductions)if(decimal(available[pid]?.available??0).lt(quantity))fail(`No hay suficientes materiales disponibles de ${products.get(pid).name}; revisa existencias y reservas`,409)
  }
  const snapshots=new Map()
  for(const [pid,p]of products)snapshots.set(pid,await physicalSnapshot(tx,p)??{version:1,factor:'1',unit_label:'unidad'})
  let location=input.location_id
  if(location)id(location)
  if(location&&!await tx.stockLocation.findFirst({where:{id:location,active:true,warehouse:{branch_id:scope.branchId,active:true}}}))fail('La ubicación no pertenece a esta sucursal',403)
  location=location||await defaultLocationId(tx,scope.branchId,{receiving:true})
  const rows=[]
  for(const row of input.items){
    const product=products.get(row.product_id),quantity=checked(row)
    if(product.tracks_expiry&&!row.expiry_date)fail(`Ingresa la caducidad de ${product.name}`)
    if(row.expiry_date&&(!/^\d{4}-\d{2}-\d{2}$/.test(row.expiry_date)||Number.isNaN(new Date(row.expiry_date).getTime())||new Date(row.expiry_date).toISOString().slice(0,10)!==row.expiry_date))fail('Fecha de caducidad inválida')
    if(row.lot_code!=null&&(typeof row.lot_code!=='string'||row.lot_code.length>60))fail('El lote admite hasta 60 caracteres')
    if(production&&row.unit_cost!=null)fail('El costo de fabricación se calcula a partir de los materiales y gastos')
    const total=production?tracked.add(manual.materials).add(manual.labor).add(manual.other).toDecimalPlaces(2):decimal(quantity).mul(parseQuantity(row.unit_cost,{decimals:12,allowZero:true,max:'9999999999.99'})).toDecimalPlaces(2)
    amount(total.toFixed(2))
    rows.push({input:row,product,quantity,total,unitCost:total.div(quantity).toDecimalPlaces(12).toFixed(12)})
  }
  const total=rows.reduce((sum,row)=>sum.add(row.total),decimal(0)).toFixed(2)
  const details=production?{version:1,components:materialRows,costs:{tracked_materials:tracked.toFixed(2),materials:manual.materials.toFixed(2),labor:manual.labor.toFixed(2),other:manual.other.toFixed(2)},total}:undefined
  const receipt=await tx.incomingMerchandise.create({data:{branch_id:scope.branchId,supplier_id:null,registered_by:scope.userId,source:input.source,notes:input.notes?.trim()||null,payment_status:'PENDING',request_company_id:scope.companyId,request_key:input.request_key,request_hash:hash,...(details?{production_details:details}:{})}})
  const ctx={reason:input.source,refType:'incoming_merchandise',refId:receipt.id,groupId:crypto.randomUUID(),userId:scope.userId,unitSnapshots:snapshots,notes:input.notes?.slice(0,300),consumeLots:true}
  if(deductions.size)await deductStockMap(tx,deductions,scope.branchId,ctx)
  for(const row of rows){
    const p=row.product,oldStock=decimal(p.stock),value=oldStock.gt(0)?oldStock.mul(p.cost).add(row.total):row.total,newStock=oldStock.gt(0)?oldStock.add(row.quantity):decimal(row.quantity)
    await tx.product.update({where:{id:p.id},data:{cost:value.div(newStock).toDecimalPlaces(12).toFixed(12)}})
    const snapshot=snapshots.get(p.id)
    await tx.incomingMerchandiseItem.create({data:{incoming_merchandise_id:receipt.id,product_id:p.id,quantity:row.quantity,unit_cost:row.unitCost,unit_metadata_version:snapshot.version===2?2:1,unit_snapshot:snapshot,base_qty:row.quantity,base_unit_cost:row.unitCost,line_total:row.total.toFixed(2)}})
    if(!production)await tx.purchaseLog.create({data:{product_id:p.id,supplier_id:null,source:'INITIAL',qty:row.quantity,cost:row.unitCost,date:new Date(),unit_metadata_version:snapshot.version===2?2:1,unit_snapshot:snapshot,base_qty:row.quantity,base_unit_cost:row.unitCost,line_total:row.total.toFixed(2)}})
    await restoreStockMap(tx,new Map([[p.id,row.quantity]]),scope.branchId,{...ctx,locationId:location})
    if(row.input.lot_code||row.input.expiry_date)await tx.productLot.create({data:{product_id:p.id,branch_id:scope.branchId,location_id:location,lot_code:row.input.lot_code?.trim()||require('./lots').generateLotCode(),expiry_date:row.input.expiry_date?new Date(row.input.expiry_date):null,qty_received:row.quantity,qty_remaining:row.quantity,unit_cost:row.unitCost,incoming_merchandise_id:receipt.id,received_at:new Date()}})
  }
  const result={incomingMerchandise:receipt,totalPurchaseValue:total,purchaseLogs:[],updatedProducts:[],lotsCreated:rows.filter(row=>row.input.lot_code||row.input.expiry_date).length}
  const saved=JSON.parse(JSON.stringify(result))
  await tx.incomingMerchandise.update({where:{id:receipt.id},data:{request_result:saved}})
  return saved
}
module.exports={registerOwnReceipt}
