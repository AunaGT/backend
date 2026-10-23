const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {objectInput}=require('../inventory/units/access')
const {parseQuantity,lineTotal}=require('../../services/units/quantity')
const {D,isV2}=require('../../services/units/commercial')
const {resolveCommercialLines}=require('../../services/units/saleLines')
const {resolvePriceTierForContext}=require('../../services/priceResolution')
const {insertSaleRecord,moveSaleStock}=require('./application')
const {commercialState}=require('./commercialState')
const fail=(code,message,status=409)=>{throw Object.assign(Error(message),{code,status})}
const has=(scope,p)=>scope.isAdmin||scope.permissions?.includes(p)
const uuid=(value,name)=>{if(typeof value!=='string'||! /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value))fail('INVALID_INPUT',`${name} inválido`,400);return value}
const text=(value,name,max)=>{if(typeof value!=='string'||value.trim().length>max)fail('INVALID_INPUT',`${name} inválido`,400);return value.trim()}
function parse(raw,mode){
 objectInput(raw,['expectedVersion','idempotencyKey',...(['SAVE','PREVIEW'].includes(mode)?['customerId','customerName','customerNit','items']:mode==='CONFIRM'?['dueDate','creditOverride']:[])])
 if(!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion>2147483647||raw.expectedVersion<(['SAVE','PREVIEW'].includes(mode)?0:1))fail('INVALID_INPUT','Actualiza la versión de la venta',400)
 const out={expectedVersion:raw.expectedVersion,idempotencyKey:uuid(raw.idempotencyKey,'Intento')}
 if(['SAVE','PREVIEW'].includes(mode)){
  out.customerId=raw.customerId==null?null:uuid(raw.customerId,'Cliente');out.customerName=text(raw.customerName??'','Nombre',150);out.customerNit=text(raw.customerNit??'','NIT',50)
  if(!Array.isArray(raw.items)||!raw.items.length||raw.items.length>100)fail('INVALID_INPUT','Agrega entre 1 y 100 partidas',400)
  out.items=raw.items.map(item=>{
   objectInput(item,['product_id','qty','presentation_id','unit_revision','accept_rounding','expected_unit_price'])
   const row={product_id:uuid(item.product_id,'Producto'),qty:parseQuantity(item.qty).toFixed()}
   if(Object.hasOwn(item,'presentation_id'))row.presentation_id=item.presentation_id===null?null:uuid(item.presentation_id,'Presentación')
   if(item.unit_revision!==undefined){if(!Number.isSafeInteger(item.unit_revision)||item.unit_revision<1)fail('INVALID_INPUT','Versión de unidad inválida',400);row.unit_revision=item.unit_revision}
   if(item.accept_rounding!==undefined){if(typeof item.accept_rounding!=='boolean')fail('INVALID_INPUT','Confirma el redondeo',400);row.accept_rounding=item.accept_rounding}
   if(mode==='SAVE'&&(typeof item.expected_unit_price!=='string'||item.expected_unit_price.length>64||!/^\d+(?:\.\d{1,18})?$/.test(item.expected_unit_price)))fail('INVALID_INPUT','Revisa el precio unitario',400)
   row.expected_unit_price=item.expected_unit_price;return row
  })
 }else if(mode==='CONFIRM'){
  if(raw.creditOverride!==undefined&&typeof raw.creditOverride!=='boolean')fail('INVALID_INPUT','Autorización de crédito inválida',400)
  out.creditOverride=raw.creditOverride===true;out.dueDate=raw.dueDate==null?null:text(raw.dueDate,'Vencimiento',10)
 }
 return out
}
async function authorize(db,scope,permission){
 if(!has(scope,permission))fail('FORBIDDEN','No tienes permiso para esta operación',403)
 uuid(scope.companyId,'Empresa');uuid(scope.userId,'Usuario')
 if(!scope.branchId||scope.branchId==='all'||scope.isConsolidated)fail('BRANCH_REQUIRED','Selecciona una sucursal',400)
 uuid(scope.branchId,'Sucursal')
 const branch=await db.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId,active:true},select:{id:true,code:true,seq:true}})
 if(!branch)fail('NOT_FOUND','Sucursal no encontrada',404)
 return branch
}
function guard(scope,row){
 if(!row||row.created_by!==scope.userId&&!has(scope,'sales.view_detail'))fail('NOT_FOUND','Venta no encontrada',404)
 if(row.origin_engagement_id||row.settlement_source!=='MANUAL_SALE')fail('SOURCE_OWNS_SALE','Gestiona esta venta desde su origen',409)
 return row
}
async function load(db,scope,id){return guard(scope,await db.sale.findFirst({where:{id,branch_id:scope.branchId,branch:{company_id:scope.companyId}},include:{status:true,sale_items:{orderBy:{id:'asc'}},orderLink:{select:{document:{select:{id:true,reference:true,doc_type:true,credit_days:true}}}}}}))}
function dto(row){return{id:row.id,reference:row.reference,version:row.version,status:commercialState(row.status.name),originQuote:row.orderLink?.document?.doc_type==='QUOTE'?{id:row.orderLink.document.id,reference:row.orderLink.document.reference}:null,customerId:row.customer_contact_id||null,customerName:row.customer||'',customerNit:row.customer_nit||'',total:D(row.total).toFixed(2),dueDate:row.due_date?.toISOString()??null,
 items:row.sale_items.map(l=>({id:l.id,productId:l.product_id,name:l.item_name,kind:l.item_kind,qty:D(l.qty).toFixed(),unitPrice:D(l.price).toFixed(),lineTotal:D(l.net_total??lineTotal(l.qty,l.price)).toFixed(2),unitLabel:l.unit_label,quantityDecimals:l.quantity_decimals,unitSnapshot:l.unit_snapshot??null,unitMetadataVersion:l.unit_metadata_version??1,baseQty:l.base_qty==null?null:D(l.base_qty).toFixed()}))}}
async function readManualSale(db,scope,id){uuid(id,'Venta');await authorize(db,scope,has(scope,'sales.create')?'sales.create':'sales.view_detail');return dto(await load(db,scope,id))}
async function priceLines(tx,scope,input){
 const customer=await customerFor(tx,scope,input.customerId)
 const tier=await resolvePriceTierForContext(tx,{companyId:scope.companyId,customerContactId:customer?.id,salesChannel:'WHOLESALE'})
 const items=await resolveCommercialLines(tx,{...scope,actorId:scope.userId},input.items,{tier})
 const total=items.reduce((sum,l)=>sum.add(l.line_total),D(0));if(total.gt('9999999999.99'))fail('INVALID_INPUT','Total fuera de rango',400)
 return {customer,items,total}
}
async function previewManualSale(db,scope,raw){
 const input=parse(raw,'PREVIEW');await authorize(db,scope,'sales.create')
 return db.$transaction(async tx=>{
  const {items,total}=await priceLines(tx,scope,input)
  return {total:total.toFixed(2),items:items.map(l=>({unitPrice:l.unit_price,lineTotal:l.line_total,unitSnapshot:l.unit_snapshot??null,baseQty:l.base_qty??l.qty}))}
 },{timeout:30000,maxWait:10000})
}
async function command(db,scope,id,raw,mode,run){
 if(id)uuid(id,'Venta');const input=parse(raw,mode),permission=mode==='CANCEL'?'sales.cancel':'sales.create'
 await authorize(db,scope,permission)
 const action=`MANUAL_${mode==='SAVE'?'SAVED':mode==='CONFIRM'?'CONFIRMED':'CANCELLED'}`,hash=createHash('sha256').update(JSON.stringify({id,input})).digest('hex')
 return db.$transaction(async tx=>{
  const branch=await authorize(tx,scope,permission)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manual-sale:${scope.companyId}:${scope.userId}:${input.idempotencyKey}`},0))`
  const previous=await tx.saleHistory.findFirst({where:{company_id:scope.companyId,actor_id:scope.userId,action,request_key:input.idempotencyKey}})
  if(previous){if(previous.branch_id!==scope.branchId||previous.input_hash!==hash)fail('REQUEST_CONFLICT','Este intento corresponde a otros datos');return dto(await load(tx,scope,previous.sale_id))}
  if(id)await tx.$queryRaw`SELECT id FROM sales WHERE id=${id}::uuid AND branch_id=${scope.branchId}::uuid FOR UPDATE`
  const row=id?await load(tx,scope,id):null
  if(row&&row.status.name!=='Borrador')fail('NOT_DRAFT','Esta venta ya no es un borrador')
  if((row?.version??0)!==input.expectedVersion)fail('VERSION_CONFLICT','La venta cambió. Recárgala antes de continuar')
  const result=await run(tx,input,row,branch)
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:result.id,actor_id:scope.userId,action,request_key:input.idempotencyKey,input_hash:hash,before:row?{version:row.version,state:'DRAFT'}:undefined,after:{version:result.version,state:commercialState(result.status.name)}}})
  return dto(result)
 },{timeout:30000,maxWait:10000})
}
async function customerFor(tx,scope,id,required=false){
 if(!id){if(required)fail('INVALID_CUSTOMER','Selecciona un cliente registrado para el saldo pendiente',400);return null}
 const customer=await tx.supplier.findFirst({where:{id,company_id:scope.companyId,party_type:'CUSTOMER',deleted:false,estado:1},include:{supplier_payment_terms:require('../receivables').CUSTOMER_TERM_PICK}})
 if(!customer)fail('INVALID_CUSTOMER','El cliente no está activo en esta empresa',400)
 return customer
}
async function saveManualSale(db,scope,id,raw){return command(db,scope,id,raw,'SAVE',async(tx,input,row,branch)=>{
 if(row?.orderLink?.document?.doc_type==='QUOTE')fail('SOURCE_OWNS_AGREEMENT','Esta venta conserva el acuerdo de la cotización; no se puede modificar desde aquí')
 const {customer,items,total}=await priceLines(tx,scope,input)
 for(const [i,line]of items.entries())if(!D(line.unit_price).eq(input.items[i].expected_unit_price))fail('PRICE_CHANGED','El precio cambió. Actualiza los productos y revisa el total antes de guardar')
 const status=await tx.saleStatus.findUnique({where:{name:'Borrador'}});if(!status)fail('SETUP_REQUIRED','Configura el estado de borrador')
 const data={customer_contact_id:customer?.id??null,customer:input.customerName||customer?.name||null,customer_nit:input.customerNit||null,is_final_consumer:!input.customerNit,subtotal:total.toFixed(2),discount_total:'0.00',total:total.toFixed(2),adjusted_total:total.toFixed(2),items:items.length,unit_metadata_version:items.some(isV2)?2:1}
 let savedId=row?.id
 if(!row){const inserted=await insertSaleRecord(tx,{userId:scope.userId,items,saleData:{...data,branch_id:scope.branchId,reference:await require('../../services/referenceGenerator').nextDocumentReference(tx,'V',branch),status_id:status.id,payment_method_id:null,payment_status:'PENDING',amount_received:null,change:null,cash_register_session_id:null,settlement_source:'MANUAL_SALE',sales_channel:'WHOLESALE'}});savedId=inserted.id}
 else{
  await tx.sale.update({where:{id:row.id,version:row.version},data:{...data,version:{increment:1}}})
  await tx.saleItem.deleteMany({where:{sale_id:row.id}})
  const {unitFields}=require('../../services/units/commercial')
  await tx.saleItem.createMany({data:items.map(l=>({sale_id:row.id,product_id:l.product_id,qty:l.qty,price:l.unit_price,unit_cost:l.unit_cost,net_total:l.line_total,item_name:l.item_name,item_kind:l.item_kind,unit_label:l.unit_label,quantity_decimals:l.quantity_decimals,...unitFields(l),...(isV2(l)?{base_returned:'0'}:{})}))})
 }
 return load(tx,scope,savedId)
})}
async function confirmManualSale(db,scope,id,raw){return command(db,scope,id,raw,'CONFIRM',async(tx,input,row)=>{
 const origin=row.orderLink?.document?.doc_type==='QUOTE'?await require('../quotes').lockQuote(tx,scope,row.orderLink.document.id):null
 if(origin&&origin.status!=='ACCEPTED')fail('QUOTE_NOT_ACCEPTED','La cotización de origen ya no está aceptada')
 const customer=await customerFor(tx,scope,row.customer_contact_id,true),credit=require('../receivables')
 await credit.lockCustomer(tx,customer.id)
 const total=D(row.total),now=new Date(),method=await require('../../services/paymentMethods/access').firstActiveCreditMethod(tx,scope.companyId);let dueDate=null
 if(total.gt(0)){
  const enabled=await tx.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'sales_allow_credit'}}})
  if(String(enabled?.value??'true').toLowerCase()!=='true')fail('CREDIT_DISABLED','Las ventas con saldo pendiente están desactivadas',403)
  const terms=require('../../services/commercialPayment')
  dueDate=terms.creditDueDate(input.dueDate,origin?.credit_days??customer.supplier_payment_terms[0]?.payment_term?.net_days,now,await terms.getTimezone(tx,scope.companyId))
  const check=await credit.checkCredit(tx,customer,total.toNumber(),{branch_id:scope.branchId})
  if(!check.ok&&!(input.creditOverride&&has(scope,'sales.credit.override')))fail('CREDIT_NOT_AVAILABLE',check.motivo||'El cliente no tiene crédito disponible')
 }
 const products=await tx.product.findMany({where:{company_id:scope.companyId,id:{in:row.sale_items.map(l=>l.product_id)},deleted:false}})
 for(const line of row.sale_items)if(!products.some(p=>p.id===line.product_id&&p.kind===line.item_kind))fail('SOURCE_REVIEW_REQUIRED','Un producto cambió; revisa el borrador')
 const items=await resolveCommercialLines(tx,{...scope,actorId:scope.userId},row.sale_items.map(({unit_cost,base_unit_cost,...l})=>({...l,unit_price:D(l.price).toFixed(),line_total:D(l.net_total).toFixed(2),qty:D(l.qty).toFixed()})),{approved:true})
 await require('../../services/stockAvailability').assertLinesAvailable(tx,items,{companyId:scope.companyId,branchId:scope.branchId,...(origin?{excludeDocumentId:origin.id}:{})})
 const status=await tx.saleStatus.findUnique({where:{name:'Completada'}});if(!status)fail('SETUP_REQUIRED','Configura el estado de venta confirmada')
 await tx.sale.update({where:{id,version:row.version},data:{status_id:status.id,version:{increment:1},confirmed_at:now,date:now,sold_at:now,payment_status:total.gt(0)?'PENDING':'PAID',payment_method_id:method?.id??null,due_date:dueDate}})
 for(const [index,line]of items.entries())await tx.saleItem.update({where:{id:row.sale_items[index].id},data:{unit_cost:line.unit_cost,...(isV2(line)?{base_unit_cost:line.base_unit_cost}:{})}})
 await moveSaleStock(tx,items,scope.branchId,{reason:'SALE',refType:'sale',refId:id,userId:scope.userId,companyId:scope.companyId})
 if(origin)await require('../../services/stockAvailability').consumeByDocument(tx,origin.id)
 await require('../../services/accounting/postingEngine').postSaleInTransaction(tx,scope,id)
 return load(tx,scope,id)
})}
async function cancelManualSale(db,scope,id,raw){return command(db,scope,id,raw,'CANCEL',async(tx,input,row)=>{
 if(row.orderLink?.document?.doc_type==='QUOTE'){
  const origin=await require('../quotes').lockQuote(tx,scope,row.orderLink.document.id)
  await require('../../services/stockAvailability').releaseByDocument(tx,origin.id,{status:'RELEASED'})
 }
 const status=await tx.saleStatus.findUnique({where:{name:'Cancelada'}});if(!status)fail('SETUP_REQUIRED','Configura el estado cancelado')
 await tx.sale.update({where:{id,version:row.version},data:{status_id:status.id,version:{increment:1}}});return load(tx,scope,id)
})}
module.exports={readManualSale,previewManualSale,saveManualSale,confirmManualSale,cancelManualSale}
