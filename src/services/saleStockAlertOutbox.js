const {ensureStockAlertsBatch,lockStockAlertProducts}=require('./stockAlerts')

async function enqueueSaleStockAlerts(tx,{saleId,companyId,branchId,productIds}){
 const ids=[...new Set(productIds)].sort()
 if(!ids.length)return
 await tx.$executeRaw`INSERT INTO sale_stock_alert_outbox (sale_id,company_id,branch_id,product_ids)
  VALUES (${saleId}::uuid,${companyId}::uuid,${branchId}::uuid,${JSON.stringify(ids)}::jsonb)
  ON CONFLICT (sale_id) DO NOTHING`
}

async function processNextSaleStockAlert(db,{ensureAlerts=ensureStockAlertsBatch}={}){
 return db.$transaction(async tx=>{
  const [job]=await tx.$queryRaw`SELECT id,company_id,branch_id,product_ids FROM sale_stock_alert_outbox
   WHERE available_at<=now() ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`
  if(!job)return 'idle'
  const [claim]=await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${`sale-stock-alert:${job.branch_id}`},0)) AS locked`
  if(!claim.locked)return 'busy'
  if(!await lockStockAlertProducts(tx,job.product_ids,job.branch_id,{tryOnly:true}))return 'busy'
  // A failed SQL statement aborts its transaction: recover only the processing savepoint.
  await tx.$executeRaw`SAVEPOINT sale_stock_alert_processing`
  try{
   const rows=await tx.productStock.findMany({where:{branch_id:job.branch_id,product_id:{in:job.product_ids},product:{company_id:job.company_id},branch:{company_id:job.company_id}},select:{product_id:true,stock:true,min_stock:true}})
   await ensureAlerts(tx,rows.map(({product_id,...row})=>({id:product_id,...row})),job.branch_id,{strict:true,guardHeld:true,transactionBound:true})
   await tx.$executeRaw`DELETE FROM sale_stock_alert_outbox WHERE id=${job.id}::bigint`
   return 'processed'
  }catch(error){
   await tx.$executeRaw`ROLLBACK TO SAVEPOINT sale_stock_alert_processing`
   const code=/^P\d{4}$|^ALERT_CATALOG_REQUIRED$/.test(error?.code||'')?error.code:'ALERT_PROCESSING_FAILED'
   await tx.$executeRaw`UPDATE sale_stock_alert_outbox SET last_error=${code},attempts=LEAST(attempts,2147483646)+1,
    available_at=now()+LEAST(3600,5*power(2,LEAST(attempts,10))) * interval '1 second' WHERE id=${job.id}::bigint`
   return 'retry'
  }
 },{timeout:30000,maxWait:5000})
}
module.exports={enqueueSaleStockAlerts,processNextSaleStockAlert}
