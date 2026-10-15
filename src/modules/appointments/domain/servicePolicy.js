function normalizeServicePolicy(profile) {
  return {...profile,schedulingStyle:profile.schedulingStyle??(profile.mode==='GROUP'?'CLASS':'APPOINTMENT'),
    durationPolicy:profile.durationPolicy??'FIXED',completionPolicy:profile.completionPolicy??'MANUAL'}
}
function resolveServiceInterval(raw,input){
  const {instant,invalid}=require('./validation'),profile=normalizeServicePolicy(raw)
  const startsAt=instant(input.startsAt,'startsAt'),start=new Date(startsAt).getTime()
  const endsAt=input.endsAt==null?new Date(start+profile.durationMinutes*60000).toISOString():instant(input.endsAt,'endsAt')
  const durationMinutes=(new Date(endsAt).getTime()-start)/60000
  if(!Number.isInteger(durationMinutes)||durationMinutes<=0||durationMinutes>(profile.schedulingStyle==='WORK'?44640:1440))
    invalid('endsAt','Selecciona un fin posterior al inicio dentro del límite del servicio')
  if(profile.durationPolicy==='FIXED'&&durationMinutes!==profile.durationMinutes)
    invalid('endsAt',`Este servicio tiene duración fija de ${profile.durationMinutes} minutos`)
  return {startsAt,endsAt,durationMinutes}
}
function isManualService(profile,input){
  return !profile.requiresProvider&&!profile.requiresResource&&!input.providerIds.length&&!input.resourceIds.length
}
function publicServicePolicy(raw){
  const p=normalizeServicePolicy(raw)
  return Object.fromEntries(['schedulingStyle','durationPolicy','durationMinutes','completionPolicy','beforeMinutes','afterMinutes','requiresProvider','requiresResource','providerIds','resourceIds','allowedVenueKinds'].map(key=>[key,p[key]]).filter(([,value])=>value!==undefined))
}
function completionInfo(row,now=new Date()){
  return {completionPolicy:row.completion_policy||'MANUAL',actualCompletedAt:row.actual_completed_at?.toISOString()||null,
    commercialCompletionConfirmedAt:row.commercial_completion_confirmed_at?.toISOString()||null,
    overdue:['SCHEDULED','IN_PROGRESS','HELD','PENDING','CONFIRMED','ARRIVED','IN_SERVICE'].includes(row.status)&&new Date(row.ends_at)<=now}
}
module.exports={normalizeServicePolicy,resolveServiceInterval,isManualService,publicServicePolicy,completionInfo}
