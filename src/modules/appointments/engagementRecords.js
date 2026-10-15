const {Prisma}=require('@prisma/client')
// Shared insertion only: the caller owns transaction, source validation and locks.
async function createEngagementRecord(tx,scope,{source,quoteId,requestKey,inputHash,origin}){
  const order=source.orders[0]
  const row=await tx.appointmentEngagement.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:source.customerId,
    source:quoteId?'QUOTE':'DIRECT',quote_id:quoteId||null,order_id:order?.id||null,currency_code:source.currencyCode,agreed_total:source.total,
    commercial_snapshot:origin?{...source,origin}:source,resolution_pending:!!order?.documentSales?.length,created_by:scope.userId,
    lines:{create:source.lines.map(l=>({source_document_id:quoteId||null,source_line_id:l.id||null,product_id:l.productId,item_kind:l.itemKind,
      item_name:l.itemName,unit_label:l.unitLabel,quantity_decimals:l.quantityDecimals,qty:l.quantity,unit_price:l.unitPrice,line_total:l.lineTotal,
      service_schedule_snapshot:l.serviceConditions??Prisma.DbNull,sort_order:l.sortOrder}))}},include:{lines:true}})
  await tx.appointmentEngagementHistory.create({data:{company_id:scope.companyId,branch_id:scope.branchId,customer_id:row.customer_id,
    engagement_id:row.id,actor_id:scope.userId,action:'CREATED',request_key:requestKey,input_hash:inputHash,...(origin?{after:{origin}}:{})}})
  return row
}
module.exports={createEngagementRecord}
