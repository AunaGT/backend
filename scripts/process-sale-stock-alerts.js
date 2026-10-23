require('../src/config/loadEnv')
async function main(args){
 if(args.length!==1||args[0]!=='--once')throw Error('USE_ONCE')
 const {prisma,prismaTransaction}=require('../src/models/prisma')
 try{
  const {processNextSaleStockAlert}=require('../src/services/saleStockAlertOutbox')
  let processed=0
  for(let i=0;i<20;i++){const result=await processNextSaleStockAlert(prismaTransaction);if(result==='idle'||result==='busy')break;if(result==='processed')processed++}
  console.log(JSON.stringify({processed}))
 }finally{await prisma.$disconnect();if(prismaTransaction!==prisma)await prismaTransaction.$disconnect()}
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{console.error('No se pudo completar el ciclo de alertas; los trabajos siguen pendientes');process.exitCode=1})
module.exports={main}
