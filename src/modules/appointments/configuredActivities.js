const {DateTime}=require('luxon')
const {fail,invalid}=require('./domain/validation')
const {normalizeServicePolicy,resolveServiceInterval}=require('./domain/servicePolicy')
const {serviceProduct,presentProfile}=require('./profiles')
const {assertAssignmentRequirements,providerIdentityMap}=require('./domain/assignmentRequirements')
const {parseOperationalTimeline,resolveOperationalTimeline,requirementEligibility}=require('./domain/operationalTimeline')
function prepareTimeline(tx,input,old){
  const operationalTimeline=parseOperationalTimeline(input.operationalTimeline===undefined?old?.operational_timeline:input.operationalTimeline)
  if(['milestones','attendanceWindows','requirementWindows'].some(k=>operationalTimeline[k].length))require('./timelineStorage').assertTimelineStorage(tx)
  resolveOperationalTimeline({timeline:operationalTimeline,session:input})
  return {...input,operationalTimeline}
}
function unconfigured(input,policySnapshot){
  if(input.operationalTimeline.requirementWindows.length)invalid('operationalTimeline.requirementWindows','Este evento no tiene requisitos de intervención')
  return {input,policySnapshot}
}
async function applyConfiguredActivityPolicy(tx,scope,input,old){
  input=prepareTimeline(tx,input,old)
  const previous=old?.policy_snapshot||{}
  let profile
  if(previous.serviceScheduling==='CONFIGURED'){
    if(input.serviceScheduling!=='CONFIGURED'||input.productId!==old.product_id)
      invalid('productId','El trabajo conserva su servicio y reglas; no puede convertirse en actividad libre')
    profile=normalizeServicePolicy(previous)
  }else if(input.serviceScheduling==='CONFIGURED'||(input.productId&&input.productId!==old?.product_id)){
    if(!input.productId) invalid('productId','Selecciona el servicio a agendar')
    await serviceProduct(tx,scope,input.productId)
    const row=await tx.serviceScheduleProfile.findFirst({where:{company_id:scope.companyId,product_id:input.productId},include:{branches:true,providers:true,resources:true,product:true}})
    if(input.serviceScheduling!=='CONFIGURED'){
      if(row?.enabled&&row.scheduling_style==='WORK') invalid('serviceScheduling','Este servicio se agenda con sus reglas de trabajo o evento')
      return unconfigured(input,previous)
    }
    if(!row?.enabled||row.product.deleted||!row.product.available_for_sale||!row.branches.some(b=>b.branch_id===scope.branchId))
      fail(409,'SERVICE_UNAVAILABLE','El servicio no está habilitado para agendar en esta sucursal')
    profile=presentProfile(row).profile
    if(profile.schedulingStyle!=='WORK') invalid('productId','Este servicio utiliza una reserva individual o sesión con cupos')
  }else return unconfigured(input,previous)
  if(!(profile.allowedVenueKinds||['BRANCH']).includes(input.venue.kind)) invalid('venue.kind','El servicio no admite este lugar de atención')
  for(const [field,required,allowed] of [['providerIds',profile.requiresProvider,profile.providerIds],['resourceIds',profile.requiresResource,profile.resourceIds]]){
    if(required&&!input[field].length) invalid(field,field==='providerIds'?'Selecciona el profesional requerido':'Selecciona la sala o equipo requerido')
    if(input[field].some(id=>!allowed?.includes(id))) invalid(field,'Selecciona asignaciones habilitadas para el servicio')
  }
  if(input.setupMinutes!==profile.beforeMinutes) invalid('setupMinutes','La preparación se toma de las reglas del servicio')
  if(input.teardownMinutes!==profile.afterMinutes) invalid('teardownMinutes','El cierre se toma de las reglas del servicio')
  const range=resolveServiceInterval(profile,input),now=Date.now(),start=new Date(range.startsAt).getTime()
  input={...input,...range}
  const requirements=[...profile.assignmentRequirements]
  // Old yes/no requirements still need one full-time assignment, not just any short visit.
  for(const [kind,required,field]of [['PROVIDER',profile.requiresProvider,'providerIds'],['RESOURCE',profile.requiresResource,'resourceIds']])
    if(required&&!requirements.some(r=>r.kind===kind))requirements.push({id:`legacy-${kind}`,kind,name:kind==='PROVIDER'?'Personal durante todo el evento':'Equipo durante todo el evento',quantity:1,optionIds:input[field]})
  if(requirements.length){
    const providers=requirements.some(r=>r.kind==='PROVIDER')?await tx.serviceProvider.findMany({where:{company_id:scope.companyId,id:{in:input.providerIds}},select:{id:true,user_id:true,employee_id:true,employee:{select:{user_id:true}}}}):[]
    const identityById=providerIdentityMap(providers),eligibleByRequirement=requirementEligibility({requirements,timeline:input.operationalTimeline,session:input,identityById})
    assertAssignmentRequirements(requirements,{...input,identityById,eligibleByRequirement})
  }else if(input.operationalTimeline.requirementWindows.length)invalid('operationalTimeline.requirementWindows','Este evento no tiene requisitos de intervención')
  if(!old&&(start<now+(profile.leadMinutes||0)*60000||start>DateTime.fromMillis(now,{zone:input.timezone}).plus({days:profile.horizonDays||60}).toMillis()))
    invalid('startsAt','El inicio está fuera de la anticipación o plazo permitido')
  return {input:{...input,completionPolicy:profile.completionPolicy},policySnapshot:{...profile,durationMinutes:range.durationMinutes,serviceScheduling:'CONFIGURED'}}
}
module.exports={applyConfiguredActivityPolicy}
