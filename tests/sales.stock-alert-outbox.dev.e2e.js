// Opt-in development check; all alert/outbox writes are rolled back.
const assert=require('node:assert/strict')
async function main(args){
 assert.deepEqual(args,['--rollback'])
 require('../src/config/loadEnv')
 const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}},log:[]})
 const {rollbackCheckout,quietDiagnostic}=require('../scripts/diagnose-pos-checkout')
 const {enqueueSaleStockAlerts,processNextSaleStockAlert}=require('../src/services/saleStockAlertOutbox')
 const {ensureStockAlertsBatch,lockStockAlertProducts}=require('../src/services/stockAlerts')
 try{
  await quietDiagnostic(()=>rollbackCheckout(db,async tx=>{
   const sale=await tx.sale.findFirst({where:{stock_alert_job:null},include:{branch:{select:{company_id:true}}}})
   assert(sale)
   const stock=await tx.productStock.findFirst({where:{branch_id:sale.branch_id,product:{company_id:sale.branch.company_id}},select:{product_id:true}});assert(stock)
   const scope={saleId:sale.id,companyId:sale.branch.company_id,branchId:sale.branch_id,productIds:[stock.product_id]}
   await enqueueSaleStockAlerts(tx,scope);await enqueueSaleStockAlerts(tx,scope)
   assert.equal(await tx.saleStockAlertJob.count({where:{sale_id:sale.id}}),1)
   assert.equal(await db.saleStockAlertJob.count({where:{sale_id:sale.id}}),0)
   await tx.$executeRaw`UPDATE sale_stock_alert_outbox SET available_at='1900-01-01' WHERE sale_id=${sale.id}::uuid`
   const nested={$transaction:run=>run(tx)}
   assert.equal(await processNextSaleStockAlert(nested,{ensureAlerts:client=>client.$queryRawUnsafe('SELECT 1/0')}),'retry')
   const retained=await tx.saleStockAlertJob.findUnique({where:{sale_id:sale.id}})
   assert.equal(retained.attempts,1);assert.equal(retained.last_error,'P2010')
   await tx.$executeRaw`UPDATE sale_stock_alert_outbox SET available_at='1900-01-01' WHERE sale_id=${sale.id}::uuid`
   assert.equal(await processNextSaleStockAlert(nested,{ensureAlerts:async(client,products,branchId,options)=>{
    assert.equal(await db.$transaction(other=>lockStockAlertProducts(other,[stock.product_id],branchId,{tryOnly:true})),false)
    await db.$transaction(other=>other.$queryRaw`SELECT id FROM product_stocks WHERE branch_id=${branchId}::uuid AND product_id=${stock.product_id}::uuid FOR UPDATE NOWAIT`)
    await ensureStockAlertsBatch(client,products,branchId,options)
   }}),'processed')
   assert.equal(await tx.saleStockAlertJob.count({where:{sale_id:sale.id}}),0)
  }))
  console.log(JSON.stringify({rolledBack:true,atomicVisibility:true,replayUnique:true,sqlFailureRetried:true,strictWorkerProcessed:true,alertGuardExcludesOtherTx:true,stockRowsRemainUnlocked:true}))
 }finally{await db.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{console.error('OUTBOX_DIAGNOSTIC_FAILED');process.exitCode=1})
