const {processNextSaleStockAlert}=require('../services/saleStockAlertOutbox')
function startSaleStockAlerts(){
 const {prismaTransaction}=require('../models/prisma')
 let running=false
 const tick=async()=>{
  if(running)return
  running=true
  try{for(let i=0;i<20;i++){const result=await processNextSaleStockAlert(prismaTransaction);if(result==='idle'||result==='busy')break}}
  catch{console.warn('[sale-stock-alerts] No se pudo completar el ciclo; los trabajos siguen pendientes')}
  finally{running=false}
 }
 const timer=setInterval(tick,10000);timer.unref();return timer
}
module.exports={startSaleStockAlerts}
