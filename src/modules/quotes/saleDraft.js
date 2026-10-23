const {D,isV2}=require('../../services/units/commercial')
const fail=(code,message,status=409)=>{throw Object.assign(Error(message),{code,status})}
const has=(scope,permission)=>scope.isAdmin||scope.permissions?.includes(permission)

// Allocate the global discount over already discounted lines, never catalogue prices.
function agreedLines(quote){
 const lines=quote.lines||[],total=D(quote.total),gross=lines.reduce((sum,line)=>sum.add(line.line_total),D(0))
 if(!lines.length||lines.length>100||total.lt(0)||total.gt(gross))fail('SOURCE_REVIEW_REQUIRED','Revisa las partidas y el total de la cotización')
 let accumulated=D(0),assigned=D(0)
 return lines.map((line,index)=>{
  accumulated=accumulated.add(line.line_total)
  const end=gross.eq(0)?D(0):index===lines.length-1?total:total.mul(accumulated).div(gross).toDecimalPlaces(2)
  const line_total=end.sub(assigned).toFixed(2);assigned=end
  return {...line,qty:String(line.qty),unit_price:String(line.unit_price),line_total}
 })
}
async function createQuoteSaleDraft(db,scope,quoteId){
 if(!has(scope,'quotes.manage')||!has(scope,'sales.create'))fail('FORBIDDEN','Necesitas administrar cotizaciones y crear ventas',403)
 if(!scope.userId||!scope.companyId||!scope.branchId||scope.branchId==='all'||scope.isConsolidated)fail('BRANCH_REQUIRED','Selecciona la sucursal de la cotización',400)
 return db.$transaction(async tx=>{
  const branch=await tx.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId,active:true},select:{id:true,code:true,seq:true}})
  if(!branch)fail('NOT_FOUND','Sucursal no encontrada',404)
  const modules=require('../platform/registry').resolveEffectiveModules(await tx.companyModule.findMany({where:{company_id:scope.companyId}}))
  if(['quotes','sales'].some(code=>!modules.find(m=>m.code===code)?.effectiveEnabled))fail('MODULE_DISABLED','Cotizaciones y Ventas deben estar habilitados',403)
  const quote=await require('./index').lockQuote(tx,scope,quoteId)
  if(quote.status!=='ACCEPTED')fail('QUOTE_NOT_ACCEPTED','Solo puedes convertir una cotización aceptada')
  const manual=require('../sales/manualSales'),linked=quote.documentSales?.[0]
  if(linked)return manual.readManualSale(tx,scope,linked.sale_id)
  if(quote.convertedChildren?.length||quote.quoted_engagement)fail('QUOTE_ALREADY_LINKED','Continúa desde el pedido o la contratación vinculada')
  if(!quote.customer_contact_id||!await tx.supplier.findFirst({where:{id:quote.customer_contact_id,company_id:scope.companyId,party_type:'CUSTOMER',deleted:false,estado:1},select:{id:true}}))fail('CONTACT_REQUIRED','Esta venta quedará pendiente de cobro. La cotización debe tener un cliente registrado y activo antes de convertirla',400)
  const items=await require('../../services/units/saleLines').resolveCommercialLines(tx,{...scope,actorId:scope.userId},agreedLines(quote),{approved:true})
  const status=await tx.saleStatus.findUnique({where:{name:'Borrador'}})
  if(!status)fail('SETUP_REQUIRED','Configura el estado de borrador')
  const sale=await require('../sales/application').insertSaleRecord(tx,{userId:scope.userId,items,saleData:{
   branch_id:scope.branchId,reference:await require('../../services/referenceGenerator').nextDocumentReference(tx,'V',branch),status_id:status.id,
   customer_contact_id:quote.customer_contact_id,customer:quote.customer,customer_nit:quote.customer_nit,is_final_consumer:quote.is_final_consumer,
   subtotal:String(quote.subtotal??quote.total),discount_total:String(quote.discount_total??0),total:String(quote.total),adjusted_total:String(quote.total),items:items.length,unit_metadata_version:items.some(isV2)?2:1,
   payment_method_id:null,payment_status:'PENDING',amount_received:null,change:null,cash_register_session_id:null,settlement_source:'MANUAL_SALE',sales_channel:quote.sales_channel||'WHOLESALE',
  }})
  await tx.commercialDocumentSale.create({data:{document_id:quote.id,sale_id:sale.id}})
  await tx.saleHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,sale_id:sale.id,actor_id:scope.userId,action:'QUOTE_DRAFT_CREATED',request_key:quote.id,input_hash:require('node:crypto').createHash('sha256').update(quote.id).digest('hex'),after:{quoteId:quote.id,reference:quote.reference,state:'DRAFT'}}})
  return manual.readManualSale(tx,scope,sale.id)
 },{timeout:30000,maxWait:10000})
}
module.exports={createQuoteSaleDraft,agreedLines}
