const {createHash}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {fail,uuid}=require('./domain/validation')
const {assertAppointmentsEnabled,hasAgendaPermission,appointmentWhere}=require('./access')
const {publicConditionsFromRow,publicServiceConditions}=require('./index')
const {assertLineCoverage}=require('./domain/engagement')
const {engagementMoney,engagementCurrencyReason,allocationSelect,allocationForReceipt}=require('../receivables')
const {effectiveStatus}=require('./presentation')
const {resolveEffectiveModules}=require('../platform/registry')
function hasCancelledSchedules(lines){return lines.some(l=>l.schedules.some(s=>s.state!=='RELEASED'&&(s.state==='CANCELLED'||s.session.status==='CANCELLED'||(s.booking&&['CANCELLED','EXPIRED','NO_SHOW'].includes(effectiveStatus(s.booking))))))}
function engagementWhere(scope){
  return {company_id:scope.companyId,branch_id:scope.branchId||{in:scope.branchIds},...(!hasAgendaPermission(scope,'appointments.view_team')?{OR:[{created_by:scope.userId},{lines:{some:{schedules:{some:{session:appointmentWhere(scope)}}}}}]}:{})}
}
const engagementInclude={customer:{select:{id:true,name:true}},lines:{orderBy:{sort_order:'asc'},include:{schedules:{include:{session:true,booking:true}}}},
  origin_sale:{select:{id:true,version:true,status:{select:{name:true}}}},
  sale:{select:{id:true,adjusted_total:true,payment_status:true}},commitments:{include:{payment:{include:{...allocationSelect,payment_method:{select:{id:true,name:true}}}}}},refunds:true,
  history:{orderBy:{created_at:'desc'},take:100}}
async function loadEngagement(db,scope,id){
  uuid(id,'engagementId')
  if(!hasAgendaPermission(scope,'appointments.view'))fail(403,'FORBIDDEN','No tienes permiso para consultar Agenda')
  const row=await db.appointmentEngagement.findFirst({where:{id,...engagementWhere(scope)},include:engagementInclude})
  if(!row)fail(404,'NOT_FOUND','Contratación no encontrada')
  return row
}
function conditionInfo(profile,product,branchId,offered){
  const current=publicConditionsFromRow(profile),available=!!profile?.enabled&&profile.branches.some(b=>b.branch_id===branchId)&&!product?.deleted&&!!product?.available_for_sale&&product?.kind==='SERVICE'
  const conditionsVersion=createHash('sha256').update(JSON.stringify({version:profile?.version||0,available,branchId,current})).digest('hex')
  return {offeredConditions:publicServiceConditions(offered),currentConditions:current,conditionsVersion,schedulingReady:available,
    conditionsChanged:JSON.stringify(publicServiceConditions(offered))!==JSON.stringify(current)}
}
function operationalState(lines,resolutionPending){
  const services=lines.filter(l=>l.item_kind==='SERVICE'),schedules=services.flatMap(l=>l.schedules.filter(s=>s.state!=='RELEASED'))
  if(resolutionPending||hasCancelledSchedules(lines))return 'REVIEW_REQUIRED'
  if(!schedules.length)return 'UNSCHEDULED'
  const remaining=services.some(l=>new Prisma.Decimal(assertLineCoverage({itemKind:l.item_kind,quantity:l.qty,quantityDecimals:l.quantity_decimals},l.schedules)).gt(0))
  if(schedules.some(s=>s.session.status==='IN_PROGRESS'||['ARRIVED','IN_SERVICE'].includes(s.booking?.status)))return 'IN_PROGRESS'
  if(!remaining&&schedules.every(s=>(s.booking?s.booking.status==='COMPLETED':s.session.status==='COMPLETED')))return 'COMPLETED'
  return remaining?'PARTIALLY_SCHEDULED':'SCHEDULED'
}
async function getEngagement(db,scope,id){
  await assertAppointmentsEnabled(db,scope)
  const row=await loadEngagement(db,scope,id),financial=hasAgendaPermission(scope,'receivables.view')
  const products=await db.product.findMany({where:{company_id:scope.companyId,id:{in:row.lines.filter(l=>l.item_kind==='SERVICE').map(l=>l.product_id)}},include:{service_schedule_profile:{include:{branches:true}}}})
  const byProduct=new Map(products.map(p=>[p.id,p]))
  const lines=row.lines.map(l=>{
    const product=byProduct.get(l.product_id)
    return {id:l.id,sourceLineId:l.source_line_id,productId:l.product_id,itemKind:l.item_kind,name:l.item_name,unitLabel:l.unit_label,quantity:l.qty.toFixed(4),quantityDecimals:l.quantity_decimals,
      ...(financial?{unitPrice:l.unit_price.toFixed(2),lineTotal:l.line_total.toFixed(2)}:{}),
      ...(l.item_kind==='SERVICE'?{...conditionInfo(product?.service_schedule_profile,product,row.branch_id,l.service_schedule_snapshot),remainingQuantity:assertLineCoverage({itemKind:l.item_kind,quantity:l.qty,quantityDecimals:l.quantity_decimals},l.schedules)}:{}),
      schedules:l.schedules.map(s=>({id:s.id,kind:s.kind,sessionId:s.session_id,bookingId:s.booking_id,quantity:s.quantity.toFixed(4),state:s.state,operationalStatus:s.booking?effectiveStatus(s.booking):s.session.status,
        startsAt:s.session.starts_at.toISOString(),endsAt:s.session.ends_at.toISOString(),timezone:s.session.timezone,venue:s.session.venue}))}
  })
  const result={id:row.id,branchId:row.branch_id,customer:row.customer,source:row.source,quoteId:row.quote_id,orderId:row.order_id,saleId:row.sale_id,version:row.version,
    correctionEngagementId:row.commercial_snapshot.replacementEngagementId||null,supersedesEngagementId:row.commercial_snapshot.supersedesEngagementId||null,
    resolutionPending:row.resolution_pending||hasCancelledSchedules(row.lines),operationalState:operationalState(row.lines,row.resolution_pending),lines,commercialReady:false,
    history:row.history.filter(h=>financial||['CREATED','PROGRAMMED','OPERATION_CHANGED'].includes(h.action)).map(h=>({id:h.id,action:h.action,reason:h.reason,at:h.created_at.toISOString()}))}
  result.commercialPreparation=row.origin_sale?'READY':'PENDING'
  if(row.origin_sale&&hasAgendaPermission(scope,'sales.view'))result.commercialDocument={id:row.origin_sale.id,version:row.origin_sale.version,state:require('../sales/commercialState').commercialState(row.origin_sale.status.name)}
  if(financial){
    result.money=await engagementMoney(db,row)
    result.receipts=row.commitments.map(c=>({id:c.payment.id,amount:c.payment.amount.toFixed(2),paidAt:c.payment.paid_at.toISOString(),method:c.payment.payment_method?.name||'No registrado',reference:c.payment.reference,notes:c.payment.notes,committed:c.state==='COMMITTED'?c.amount.toFixed(2):'0.00',commitmentState:c.state,allocation:allocationForReceipt(c.payment)}))
    result.refunds=row.refunds.map(r=>({id:r.id,receiptId:r.payment_id,amount:r.amount.toFixed(2),status:r.status,reason:r.reason,reference:r.reference,confirmedAt:r.confirmed_at?.toISOString()||null}))
    result.paymentState=row.refunds.some(r=>r.status==='REQUESTED')?'REFUND_PENDING':new Prisma.Decimal(result.money.remaining).eq(0)?'PAID':new Prisma.Decimal(result.money.committed).add(result.money.applied).gt(0)?'PARTIAL':'UNPAID'
    if(new Prisma.Decimal(result.money.refunded).gt(0)&&new Prisma.Decimal(result.money.committed).add(result.money.applied).eq(0))result.paymentState='REFUNDED'
    const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:scope.companyId}})),enabled=code=>!!modules.find(m=>m.code===code)?.effectiveEnabled
    const ready=['appointments','sales','receivables'].every(enabled)
    let accountReason='',saleAccountReason=''
    if(enabled('accounting')){
      const core=require('../../services/accounting/core')
      try{await core.getEngagementAccounts(db,scope.companyId)}catch(error){if(!(error instanceof core.AccountingError))throw error;accountReason=error.message}
      try{await core.getDefaultAccounts(db,scope.companyId)}catch(error){if(!(error instanceof core.AccountingError))throw error;saleAccountReason=error.message}
    }
    const pendingRefund=row.refunds.some(r=>r.status==='REQUESTED'),superseded=!!result.correctionEngagementId,blocked=result.resolutionPending||superseded
    const sourceReason=row.quote_id&&(!enabled('quotes')||!hasAgendaPermission(scope,'quotes.view'))?'Necesitas acceso a la cotización de origen para validar el alcance':''
    const orderReason=row.order_id&&(!enabled('orders')||!hasAgendaPermission(scope,'orders.view')||!hasAgendaPermission(scope,'orders.manage'))?'Necesitas acceso de gestión al pedido vinculado para generar su venta':''
    const currencyReason=await engagementCurrencyReason(db,scope,row)
    const reason=!ready?'Agenda, Cartera y Ventas deben estar habilitados':currencyReason||accountReason||sourceReason
    const financialWrite=scope.branchId&&hasAgendaPermission(scope,'receivables.manage')
    result.commercialReady=ready
    result.capabilities={
      collect:!!financialWrite&&hasAgendaPermission(scope,'appointments.collect')&&ready&&!reason&&!blocked&&!pendingRefund&&new Prisma.Decimal(result.money.remaining).gt(0),
      resolve:!!financialWrite&&hasAgendaPermission(scope,'appointments.refund')&&ready&&!currencyReason&&!row.sale_id,
      issueSale:!!scope.branchId&&hasAgendaPermission(scope,'appointments.issue_sale')&&hasAgendaPermission(scope,'sales.create')&&ready&&!reason&&!orderReason&&!saleAccountReason&&!blocked&&!pendingRefund&&!row.sale_id,
      reason:reason||orderReason||saleAccountReason||(!ready?'':superseded?'El alcance fue sustituido por una nueva cotización':result.resolutionPending?'Resuelve el alcance comercial antes de recibir pagos o generar venta':pendingRefund?'Resuelve la devolución pendiente':''),
    }
  }
  return result
}
module.exports={getEngagement,loadEngagement,engagementWhere,conditionInfo,operationalState,hasCancelledSchedules}
