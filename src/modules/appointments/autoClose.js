const {withAgendaTransaction}=require('./application')
const {assertAppointmentsEnabled}=require('./access')
const {resolveEffectiveModules}=require('../platform/registry')
async function recordAutomaticClose(tx,row,now){
  const reason='Cierre de horario automático. No confirma prestación comercial, asistencia ni pagos.'
  await tx.appointmentHistory.create({data:{company_id:row.company_id,branch_id:row.branch_id,session_id:row.id,actor_id:null,action:'AUTO_COMPLETE',reason,created_at:now,
    before:{status:row.status,plannedEnd:row.ends_at.toISOString()},after:{status:'COMPLETED',actualCompletedAt:now.toISOString(),commercialCompletionConfirmed:false}}})
  const links=await tx.appointmentEngagementSchedule.findMany({where:{company_id:row.company_id,session_id:row.id,state:'COMMITTED'},select:{engagement_id:true}})
  for(const id of new Set(links.map(l=>l.engagement_id))){
    const e=await tx.appointmentEngagement.update({where:{id},data:{version:{increment:1}},select:{id:true,customer_id:true}})
    await tx.appointmentEngagementHistory.create({data:{company_id:row.company_id,branch_id:row.branch_id,customer_id:e.customer_id,engagement_id:id,actor_id:null,action:'OPERATION_CHANGED',reason,
      request_key:`auto-close:${row.id}:${row.version}`,input_hash:require('node:crypto').createHash('sha256').update(`${row.id}:${row.version}`).digest('hex'),created_at:now,after:{sessionId:row.id,action:'AUTO_COMPLETE'}}})
  }
}
async function closeDueActivities(db,{now=new Date(),limit=100}={}){
  if(!Number.isFinite(now.getTime()))throw new Error('Hora de cierre no válida')
  const take=Math.min(100,Math.max(1,Math.trunc(limit)||100))
  const companies=await db.companyModule.findMany({where:{module_code:'appointments',status:{in:['ACTIVE','TRIAL']}},select:{company_id:true,company:{select:{company_modules:true}}}})
  const enabled=companies.filter(row=>resolveEffectiveModules(row.company.company_modules,now).find(m=>m.code==='appointments')?.effectiveEnabled).map(row=>row.company_id)
  const candidates=enabled.length?await db.appointmentSession.findMany({where:{company_id:{in:enabled},record_type:'ACTIVITY',status:'IN_PROGRESS',completion_policy:'AUTO',ends_at:{lte:now}},select:{id:true,company_id:true,version:true},orderBy:[{ends_at:'asc'},{id:'asc'}],take}):[]
  const result={processed:candidates.length,closed:0,skipped:0,failed:0}
  for(const candidate of candidates){
    try{
      const closed=await withAgendaTransaction(db,candidate.company_id,async tx=>{
        try{await assertAppointmentsEnabled(tx,{companyId:candidate.company_id})}catch(e){if(e.code==='MODULE_DISABLED')return false;throw e}
        const row=await tx.appointmentSession.findFirst({where:{id:candidate.id,company_id:candidate.company_id,version:candidate.version,record_type:'ACTIVITY',status:'IN_PROGRESS',completion_policy:'AUTO',ends_at:{lte:now}}})
        if(!row)return false
        const changed=await tx.appointmentSession.updateMany({where:{id:row.id,company_id:row.company_id,version:row.version,status:'IN_PROGRESS',completion_policy:'AUTO',ends_at:{lte:now}},data:{status:'COMPLETED',actual_completed_at:now,version:{increment:1}}})
        if(changed.count!==1)return false
        await recordAutomaticClose(tx,row,now)
        return true
      })
      if(closed)result.closed++;else result.skipped++
    }catch(error){result.failed++;console.error('[appointment-auto-close] No se pudo cerrar una actividad:',error.message)}
  }
  return result
}
module.exports={closeDueActivities,recordAutomaticClose}
