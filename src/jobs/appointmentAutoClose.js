let timer=null,running=false
async function runAppointmentAutoClose(){
  if(running)return null
  running=true
  try{
    const {prismaTransaction}=require('../models/prisma')
    const result=await require('../modules/appointments/autoClose').closeDueActivities(prismaTransaction,{limit:100})
    if(result.closed||result.failed)console.log('[appointment-auto-close]',result)
    return result
  }catch(e){console.error('[appointment-auto-close] No se pudo ejecutar el cierre de horarios:',e.message);return null}finally{running=false}
}
function startAppointmentAutoClose(){if(timer)return;void runAppointmentAutoClose();timer=setInterval(()=>void runAppointmentAutoClose(),60000);timer.unref?.()}
function stopAppointmentAutoClose(){if(timer)clearInterval(timer);timer=null}
module.exports={runAppointmentAutoClose,startAppointmentAutoClose,stopAppointmentAutoClose}
