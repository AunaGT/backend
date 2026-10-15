const {DateTime}=require('luxon')
const {fail}=require('./domain/validation')
const {activityInterval,validateVenueAssignments}=require('./domain/activities')
const {sessionOccupies,calendarWindows,overlaps,assigned,ABSENCES}=require('./domain/availability')
const {agendaCapabilities}=require('./access')
const unique=values=>[...new Set(values.filter(Boolean))]

async function resolveBusyIdentities(db,scope,{userIds=[],providerIds=[]},capabilities) {
  const hr=(capabilities||await agendaCapabilities(db,scope)).hr
  const links=await db.serviceProvider.findMany({where:{company_id:scope.companyId,OR:[
    {id:{in:providerIds}},{user_id:{in:userIds}},...(hr?[{employee:{user_id:{in:userIds}}}]:[])]},
    select:{id:true,user_id:true,employee_id:true,...(hr?{employee:{select:{user_id:true}}}:{})}})
  const users=unique([...userIds,...links.flatMap(p=>[p.user_id,p.employee?.user_id])])
  const employees=hr&&users.length ? await db.employee.findMany({where:{company_id:scope.companyId,user_id:{in:users}},select:{id:true,user_id:true}}) : []
  return {userIds:users,providerIds:unique([...providerIds,...links.map(p=>p.id)]),
    employeeIds:unique([...links.map(p=>p.employee_id),...employees.map(e=>e.id)]),links}
}
async function loadBusyAssignments(db,scope,{from,to,identities,resourceIds=[],excludeSessionId,includeGroups,now=new Date()}) {
  const ors=[{providers:{some:{provider_id:{in:identities.providerIds}}}},
    {organizer_id:{in:identities.userIds}},{participants:{some:{kind:'USER',user_id:{in:identities.userIds}}}},
    {resources:{some:{resource_id:{in:resourceIds}}}}]
  if(includeGroups) ors.push({branch_id:includeGroups.branchId,product_id:includeGroups.productId,mode:'GROUP',record_type:'SCHEDULED_SERVICE'})
  const rows=await db.appointmentSession.findMany({where:{company_id:scope.companyId,
    ...(excludeSessionId?{id:{not:excludeSessionId}}:{}),
    OR:ors,AND:[{OR:[{status:{in:['SCHEDULED','IN_PROGRESS']}},{record_type:'ACTIVITY',status:'COMPLETED',occupied_until:{gt:now}}]}],
    occupied_from:{lt:new Date(to)},occupied_until:{gt:new Date(from)}},select:{
    id:true,branch_id:true,product_id:true,record_type:true,organizer_id:true,mode:true,status:true,capacity:true,
    starts_at:true,ends_at:true,occupied_from:true,occupied_until:true,timezone:true,venue:true,providers:true,resources:true,
    participants:{where:{kind:'USER'},select:{user_id:true}},bookings:{select:{session_id:true,status:true,expires_at:true}}},take:10001})
  if(rows.length>10000) fail(400,'RANGE_TOO_LARGE','Selecciona un período con menos actividades')
  return rows.filter(row=>sessionOccupies(row,row.bookings,now)).map(row=>{
    const users=unique([row.organizer_id,...(row.participants||[]).map(p=>p.user_id)])
    const providers=assigned(row,'providers')
    // Expand only identities represented by this block, not every candidate professional.
    for(const link of identities.links||[]) if(providers.includes(link.id)||users.includes(link.user_id)||users.includes(link.employee?.user_id)) {
      providers.push(link.id); users.push(...[link.user_id,link.employee?.user_id].filter(Boolean))
    }
    return {start:new Date(row.occupied_from).getTime(),end:new Date(row.occupied_until).getTime(),
      sessionId:row.id,userIds:unique(users),providerIds:unique(providers),resourceIds:assigned(row,'resources'),session:row}
  })
}
async function validateActivityPeople(db,scope,input) {
  const userIds=unique([input.organizerId,...input.userIds])
  const [users,providers,resources,branch]=await Promise.all([
    db.userCompany.findMany({where:{company_id:scope.companyId,status:'ACTIVE',user_id:{in:userIds},
      user:{user_branches:{some:{branch_id:scope.branchId}}}},select:{user_id:true}}),
    db.serviceProvider.findMany({where:{company_id:scope.companyId,id:{in:input.providerIds},active:true,branches:{some:{branch_id:scope.branchId}}},select:{id:true}}),
    db.scheduleResource.findMany({where:{company_id:scope.companyId,id:{in:input.resourceIds},branch_id:scope.branchId,active:true}}),
    db.branch.findFirst({where:{id:scope.branchId,company_id:scope.companyId,active:true},select:{id:true}}),
  ])
  if(!branch||userIds.some(id=>!users.some(u=>u.user_id===id))||input.providerIds.some(id=>!providers.some(p=>p.id===id))||input.resourceIds.some(id=>!resources.some(r=>r.id===id)))
    fail(400,'INVALID_ASSIGNMENTS','Selecciona responsables, personal y equipo activos de esta sucursal')
  return {userIds,resources}
}
async function assertActivityAvailability(db,scope,input,{excludeSessionId}={}) {
  const {userIds,resources}=await validateActivityPeople(db,scope,input)
  validateVenueAssignments(input.venue,resources,input.estimatedAttendance)
  const capabilities=await agendaCapabilities(db,scope)
  const identities=await resolveBusyIdentities(db,scope,{userIds,providerIds:input.providerIds},capabilities)
  const range=activityInterval(input), interval={start:new Date(range.occupiedFrom).getTime(),end:new Date(range.occupiedUntil).getTime()}
  const [busy,calendars,absences]=await Promise.all([
    loadBusyAssignments(db,scope,{from:range.occupiedFrom,to:range.occupiedUntil,identities,resourceIds:input.resourceIds,excludeSessionId}),
    db.scheduleCalendar.findMany({where:{company_id:scope.companyId,OR:[{branch_id:scope.branchId},
      {provider_id:{in:identities.providerIds}},{resource_id:{in:input.resourceIds}}]},include:{rules:true,exceptions:true}}),
    capabilities.hr&&identities.employeeIds.length ? db.attendance.findMany({where:{company_id:scope.companyId,
      employee_id:{in:identities.employeeIds},status:{in:ABSENCES},work_date:{gte:new Date(interval.start-172800000),lte:new Date(interval.end+172800000)}},
      select:{employee_id:true,work_date:true}}) : [],
  ])
  if(busy.some(block=>overlaps(interval,block))) fail(409,'SCHEDULE_CONFLICT','El personal o equipo ya está ocupado en ese intervalo')
  const branch=calendars.find(c=>c.branch_id===scope.branchId)
  const applicable=calendars.filter(c=>c.owner_type!=='branch'||input.venue.kind==='BRANCH')
  for(const c of applicable) if(!calendarWindows(c,branch,interval.start,interval.end).some(w=>w.start<=interval.start&&w.end>=interval.end))
    fail(409,'OUTSIDE_CALENDAR','El intervalo ocupado está fuera de un horario o cierre configurado')
  if(absences.some(a=>{
    const provider=identities.links.find(p=>p.employee_id===a.employee_id)
    const zone=calendars.find(c=>c.provider_id===provider?.id)?.timezone||input.timezone
    const day=DateTime.fromISO(a.work_date.toISOString().slice(0,10),{zone}).startOf('day')
    return overlaps(interval,{start:day.toMillis(),end:day.plus({days:1}).toMillis()})
  })) fail(409,'ABSENCE_CONFLICT','Hay una ausencia registrada durante el tiempo ocupado')
  return {range,identities,resources}
}
module.exports={resolveBusyIdentities,loadBusyAssignments,assertActivityAvailability,validateActivityPeople}
