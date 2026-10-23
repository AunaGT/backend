require('../src/config/loadEnv')
const {randomUUID}=require('node:crypto')
const {prisma}=require('../src/models/prisma')
const {processNextDocument}=require('../src/modules/sales/documents/worker')
const workerId=`documents-${randomUUID()}`
let stopped=false
process.on('SIGTERM',()=>{stopped=true});process.on('SIGINT',()=>{stopped=true})
async function main(){
  console.log(JSON.stringify({event:'document_worker_started',workerId}))
  while(!stopped){
    try{const state=await processNextDocument(prisma,{workerId,onMetrics:metrics=>console.log(JSON.stringify({event:'document_worker_metrics',...metrics}))});if(state!=='idle')console.log(JSON.stringify({event:'document_worker_job',state}));if(state==='idle')await new Promise(resolve=>setTimeout(resolve,1000))}
    catch(error){console.error(JSON.stringify({event:'document_worker_error',code:/^[A-Z_0-9]{3,80}$/.test(error.code||'')?error.code:'WORKER_FAILED'}));await new Promise(resolve=>setTimeout(resolve,2000))}
  }
}
main().finally(()=>prisma.$disconnect())
