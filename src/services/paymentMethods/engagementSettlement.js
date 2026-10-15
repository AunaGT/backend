const {Prisma}=require('@prisma/client')
const {firstActiveCreditMethod,findHistoricalPaymentMethod,fail}=require('./access')
async function resolveEngagementSettlementMethod(tx,scope,e,remaining) {
  if(e.company_id!==scope.companyId||e.branch_id!==scope.branchId)fail('PM_NOT_FOUND',404,'Contratación no encontrada')
  if(new Prisma.Decimal(remaining).gt(0))return (await firstActiveCreditMethod(tx,scope.companyId)).id
  const rows=await tx.paymentCommitment.findMany({where:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:e.customer_id,engagement_id:e.id,state:'COMMITTED',payment:{branch_id:scope.branchId,customer_id:e.customer_id}},
    select:{company_id:true,branch_id:true,customer_id:true,engagement_id:true,state:true,payment:{select:{id:true,branch_id:true,customer_id:true,payment_method_id:true}}}})
  for(const r of rows)if(r.company_id!==scope.companyId||r.branch_id!==scope.branchId||r.customer_id!==e.customer_id||r.engagement_id!==e.id||r.state!=='COMMITTED'||r.payment?.branch_id!==scope.branchId||r.payment?.customer_id!==e.customer_id)
    fail('PM_NOT_FOUND',404,'Recibo no encontrado en la contratación')
  const ids=[...new Set(rows.map(r=>r.payment.payment_method_id))]
  for(const id of ids)if(id!=null)await findHistoricalPaymentMethod(tx,scope.companyId,id)
  return ids.length===1&&ids[0]!=null?ids[0]:null
}
module.exports={resolveEngagementSettlementMethod}
