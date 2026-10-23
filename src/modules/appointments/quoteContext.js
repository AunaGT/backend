const {hasPerm}=require('../../middlewares/tenant')
const {resolveEffectiveModules}=require('../platform/registry')
const {engagementWhere}=require('./commercialQueries')
function requestAgendaScope(req){return {companyId:req.companyId,branchId:req.branchId||null,branchIds:req.branchIds||req.userBranchIds||[],userId:req.user.sub,permissions:req.user.permissions||[],isAdmin:hasPerm({...req.user,permissions:[]},'appointments.view')}}
async function quoteAgendaContext(db,req,quote){
  const denied=reason=>({engagementId:null,agenda:{canOpen:false,canCreate:false,reason}})
  if(quote.documentSales?.length)return denied('La cotización ya tiene una venta vinculada')
  if(!hasPerm(req.user,'appointments.view'))return denied('Necesitas acceso a Agenda')
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:req.companyId}}))
  if(!modules.find(m=>m.code==='appointments')?.effectiveEnabled)return denied('Agenda no está habilitada para esta empresa')
  const scope=requestAgendaScope(req)
  const existing=await db.appointmentEngagement.findFirst({where:{quote_id:quote.id,...engagementWhere(scope)},select:{id:true}})
  if(existing)return {engagementId:existing.id,agenda:{canOpen:true,canCreate:false,reason:''}}
  if(await db.appointmentEngagement.count({where:{company_id:req.companyId,branch_id:quote.branch_id,quote_id:quote.id}}))return denied('La cotización ya tiene una contratación no accesible para tu usuario')
  if(!req.branchId||req.branchId!==quote.branch_id)return denied('Selecciona la sucursal de esta cotización')
  if(!hasPerm(req.user,'appointments.create'))return denied('Necesitas permiso para crear en Agenda')
  if(quote.status!=='ACCEPTED')return denied('Acepta la cotización antes de agendar')
  if(!quote.lines.some(l=>l.item_kind==='SERVICE'))return denied('La cotización no contiene servicios')
  if(!quote.customer_contact_id||!await db.supplier.findFirst({where:{id:quote.customer_contact_id,company_id:req.companyId,party_type:'CUSTOMER',deleted:false,estado:1},select:{id:true}}))return denied('Vincula un cliente registrado y activo antes de agendar')
  return {engagementId:null,agenda:{canOpen:false,canCreate:true,reason:''}}
}
async function linkedEngagementOrigins(db,req,{orderId,paymentIds=[]}){
  const result={orderEngagementId:null,payments:{}}
  if(!hasPerm(req.user,'appointments.view')||!orderId&&!paymentIds.length)return result
  const modules=resolveEffectiveModules(await db.companyModule.findMany({where:{company_id:req.companyId}}))
  if(!modules.find(m=>m.code==='appointments')?.effectiveEnabled)return result
  const ids=[...new Set(paymentIds)].slice(0,500)
  const rows=await db.appointmentEngagement.findMany({where:{AND:[engagementWhere(requestAgendaScope(req)),{OR:[...(orderId?[{order_id:orderId}]:[]),...(ids.length?[{commitments:{some:{payment_id:{in:ids}}}}]:[])]}]},select:{id:true,order_id:true,commitments:{where:{payment_id:{in:ids}},select:{payment_id:true}}}})
  for(const row of rows){if(row.order_id===orderId)result.orderEngagementId=row.id;for(const c of row.commitments)result.payments[c.payment_id]=row.id}
  return result
}
module.exports={quoteAgendaContext,linkedEngagementOrigins}
