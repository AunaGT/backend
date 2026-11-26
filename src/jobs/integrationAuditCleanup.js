const {cleanupIntegrationHistory}=require('../modules/integrations/audit')
let running=false
async function runIntegrationCleanup({db,now=new Date(),limit=500}={}){
 if(running)return{skipped:true}
 running=true
 try{return await cleanupIntegrationHistory(db||require('../models/prisma').prisma,{now,limit})}finally{running=false}
}
function startIntegrationAuditCleanup(){
 if(process.env.NODE_ENV==='test')return
 const timer=setInterval(()=>{void runIntegrationCleanup().catch(()=>console.warn('[integration-audit] Limpieza no disponible'))},3600000)
 timer.unref();return timer
}
module.exports={runIntegrationCleanup,startIntegrationAuditCleanup}
