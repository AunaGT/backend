const {computeSlots}=require('./domain/availability')
const {resolveServiceInterval}=require('./domain/servicePolicy')
const {fail}=require('./domain/validation')
const {assertAssignmentRequirements,providerIdentityMap}=require('./domain/assignmentRequirements')
function assertServiceInterval(context,input,now,{scheduleGroup=false}={}){
  const explicit=(context.profile.assignmentRequirements??[]).filter(r=>(r.kind==='PROVIDER'?context.providerIds:context.resourceIds)?.length)
  assertAssignmentRequirements(explicit,{providerIds:context.providerIds,resourceIds:context.resourceIds,identityById:context.providerIdentityById??providerIdentityMap(context.providers)})
  const range=resolveServiceInterval(context.profile,input)
  const slot=computeSlots({...context,profile:{...context.profile,durationMinutes:range.durationMinutes},now,scheduleGroup,exactStart:range.startsAt})
    .find(s=>s.startsAt===range.startsAt&&!s.sessionId)
  if(!slot) fail(409,'SLOT_UNAVAILABLE','El intervalo ocupado ya no está disponible; revisa horario y asignaciones')
  if(slot.timezone!==input.timezone) fail(400,'INVALID_TIMEZONE','Usa la zona horaria de la sucursal')
  return slot
}
module.exports={assertServiceInterval}
