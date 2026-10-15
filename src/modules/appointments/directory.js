const { object, text, ids, uuid, boolean, choice, integer, version, fail } = require('./domain/validation')
const { hasAgendaPermission, assertAgendaWrite, assertAppointmentsEnabled } = require('./access')
const { resolveEffectiveModules } = require('../platform/registry')

function assertConfigure(scope) {
  assertAgendaWrite(scope)
  if (!hasAgendaPermission(scope, 'appointments.configure')) fail(403, 'FORBIDDEN', 'No tienes permiso para configurar Agenda')
}
async function hrEnabled(db, companyId) {
  const rows = await db.companyModule.findMany({ where: { company_id: companyId } })
  return !!resolveEffectiveModules(rows).find(item => item.code === 'hr')?.effectiveEnabled
}
async function validateBranches(db, scope, selected) {
  if (!selected.length || selected.some(id => !scope.branchIds.includes(id))) fail(403, 'FORBIDDEN', 'Selecciona sucursales autorizadas')
  const rows = await db.branch.findMany({ where: { company_id: scope.companyId, id: { in: selected }, active: true }, select: { id: true } })
  if (selected.some(id => !rows.some(row => row.id === id))) fail(400, 'INVALID_BRANCH', 'Una sucursal ya no está disponible')
}
async function saveProvider(tx, scope, id, raw) {
  assertConfigure(scope)
  await assertAppointmentsEnabled(tx, scope)
  const v = object(raw, ['name', 'employeeId', 'userId', 'branchIds', 'active', 'expectedVersion'])
  const name = text(v.name, 'name', 150), branchIds = ids(v.branchIds, 'branchIds'), active = boolean(v.active, 'active')
  await validateBranches(tx, scope, branchIds)
  const old = id ? await tx.serviceProvider.findFirst({ where: { id: uuid(id, 'providerId'), company_id: scope.companyId, branches: { some: { branch_id: { in: scope.branchIds } } } }, include: { branches: true } }) : null
  if (id && !old) fail(404, 'NOT_FOUND', 'Profesional no encontrado')
  if (old && old.branches.some(branch => !scope.branchIds.includes(branch.branch_id))) fail(403, 'FORBIDDEN', 'Este profesional tiene sucursales fuera de tu alcance; solicita su configuración a un responsable')
  if (old && version(v.expectedVersion) !== old.version) fail(409, 'STALE_VERSION', 'Otra persona cambió este profesional')
  const employeeId = v.employeeId === undefined ? old?.employee_id ?? null : v.employeeId === null ? null : uuid(v.employeeId, 'employeeId')
  let userId = v.userId === undefined ? old?.user_id ?? null : v.userId === null ? null : uuid(v.userId, 'userId')
  if (employeeId && (employeeId !== old?.employee_id || userId !== old?.user_id)) {
    if (employeeId !== old?.employee_id && !await hrEnabled(tx, scope.companyId)) fail(403, 'HR_DISABLED', 'Activa RR. HH. para vincular un empleado')
    const employee = await tx.employee.findFirst({ where: { id: employeeId, company_id: scope.companyId, branch_id: { in: scope.branchIds }, status: 'ACTIVO' }, select: { id: true, user_id: true } })
    if (!employee) fail(404, 'NOT_FOUND', 'Empleado no encontrado o inactivo')
    if (v.userId != null && v.userId !== employee.user_id) fail(400, 'INVALID_USER', 'El usuario debe coincidir con el vinculado al empleado')
    userId = employee.user_id
  }
  if (userId && userId !== old?.user_id && !await tx.userCompany.findFirst({ where: { company_id: scope.companyId, user_id: userId, status: 'ACTIVE' }, select: { user_id: true } })) fail(400, 'INVALID_USER', 'El usuario no tiene acceso activo a esta empresa')
  if ((employeeId || userId) && (employeeId !== old?.employee_id || userId !== old?.user_id)) {
    const duplicate = await tx.serviceProvider.findFirst({ where: { company_id: scope.companyId, ...(id ? { id: { not: id } } : {}),
      OR: [...(employeeId ? [{ employee_id: employeeId }] : []), ...(userId ? [{ user_id: userId }, { employee: { user_id: userId } }] : [])] }, select: { id: true } })
    if (duplicate) fail(409, 'PROVIDER_ALREADY_LINKED', 'Esta persona ya tiene un profesional registrado; reutiliza su ficha')
  }
  const data = { name, employee_id: employeeId, user_id: userId, active }
  if(old&&(employeeId!==old.employee_id||userId!==old.user_id)) {
    const {resolveBusyIdentities,loadBusyAssignments}=require('./occupancy')
    const {sessionOccupies,overlaps}=require('./domain/availability')
    const now=new Date()
    const future=await tx.appointmentSession.findMany({where:{company_id:scope.companyId,occupied_until:{gt:now},
      providers:{some:{provider_id:id}},status:{in:['SCHEDULED','IN_PROGRESS','COMPLETED']}},
      select:{id:true,record_type:true,mode:true,status:true,occupied_from:true,occupied_until:true,
        bookings:{select:{session_id:true,status:true,expires_at:true}}},take:1001})
    const occupied=future.filter(s=>sessionOccupies(s,s.bookings,now))
    if(future.length>1000) fail(409,'IDENTITY_CHANGE_LIMIT','Reasigna primero las actividades futuras de este profesional')
    if(occupied.length&&userId) {
      const identities=await resolveBusyIdentities(tx,scope,{userIds:[userId],providerIds:[]})
      const from=new Date(Math.min(...occupied.map(s=>s.occupied_from.getTime())))
      const to=new Date(Math.max(...occupied.map(s=>s.occupied_until.getTime())))
      const busy=await loadBusyAssignments(tx,scope,{from,to,identities})
      if(occupied.some(s=>busy.some(b=>b.sessionId!==s.id&&overlaps({start:s.occupied_from.getTime(),end:s.occupied_until.getTime()},b))))
        fail(409,'IDENTITY_CONFLICT','La persona tiene actividades que se cruzan con las de este profesional; reasigna antes de vincular')
    }
  }
  let saved
  if (old) {
    const changed = await tx.serviceProvider.updateMany({ where: { company_id: scope.companyId, id, version: old.version }, data: { ...data, version: { increment: 1 } } })
    if (changed.count !== 1) fail(409, 'STALE_VERSION', 'Otra persona cambió este profesional')
    saved = { id, ...data, version: old.version + 1 }
  } else saved = await tx.serviceProvider.create({ data: { ...data, company_id: scope.companyId, created_by: scope.userId } })
  await tx.serviceProviderBranch.deleteMany({ where: { company_id: scope.companyId, provider_id: saved.id } })
  await tx.serviceProviderBranch.createMany({ data: branchIds.map(branch_id => ({ company_id: scope.companyId, provider_id: saved.id, branch_id })) })
  return { id: saved.id, name, employeeId, userId, active, version: saved.version, branchIds }
}
async function saveResource(tx, scope, id, raw) {
  assertConfigure(scope)
  await assertAppointmentsEnabled(tx, scope)
  const v = object(raw, ['name', 'type', 'personCapacity', 'active', 'expectedVersion','portable'])
  const name = text(v.name, 'name', 150), type = choice(v.type, 'type', ['ROOM', 'EQUIPMENT']), active = boolean(v.active, 'active')
  const personCapacity = v.personCapacity === null && type === 'EQUIPMENT' ? null : integer(v.personCapacity, 'personCapacity', 1, 10000)
  const old = id ? await tx.scheduleResource.findFirst({ where: { id: uuid(id, 'resourceId'), company_id: scope.companyId, branch_id: scope.branchId } }) : null
  if (id && !old) fail(404, 'NOT_FOUND', 'Recurso no encontrado en la sucursal activa')
  if (old && version(v.expectedVersion) !== old.version) fail(409, 'STALE_VERSION', 'Otra persona cambió este recurso')
  const portable=v.portable===undefined?old?.portable??false:boolean(v.portable,'portable')
  if(type==='ROOM'&&portable) fail(400,'RESOURCE_NOT_PORTABLE','Una sala no es transportable')
  const data = { name, type, person_capacity: personCapacity, active,portable }
  let saved
  if (old) {
    const changed = await tx.scheduleResource.updateMany({ where: { id, company_id: scope.companyId, branch_id: scope.branchId, version: old.version }, data: { ...data, version: { increment: 1 } } })
    if (changed.count !== 1) fail(409, 'STALE_VERSION', 'Otra persona cambió este recurso')
    saved = { id, ...data, version: old.version + 1 }
  } else saved = await tx.scheduleResource.create({ data: { ...data, company_id: scope.companyId, branch_id: scope.branchId } })
  return { id: saved.id, name, type, personCapacity, active,portable, branchId: scope.branchId, version: saved.version }
}
async function listDirectory(db, scope) {
  await assertAppointmentsEnabled(db, scope)
  const branchCalendar=scope.branchId?await db.scheduleCalendar.findFirst({where:{company_id:scope.companyId,branch_id:scope.branchId,owner_type:'branch'},select:{timezone:true}}):null
  const timezone=branchCalendar?.timezone||(await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'timezone'}}}))?.value||'America/Guatemala'
  const branchIds = scope.branchId ? [scope.branchId] : scope.branchIds
  const configure = hasAgendaPermission(scope, 'appointments.configure')
  const [branches, providers, resources] = await Promise.all([
    db.branch.findMany({ where: { company_id: scope.companyId, id: { in: configure ? scope.branchIds : branchIds }, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1001 }),
    db.serviceProvider.findMany({ where: { company_id: scope.companyId, branches: { some: { branch_id: { in: branchIds } } }, ...(!configure && !hasAgendaPermission(scope, 'appointments.view_team') ? { OR: [{ user_id: scope.userId }, { employee: { user_id: scope.userId } }] } : {}) }, select: { id: true, name: true, employee_id: true, user_id: true, active: true, version: true, branches: { select: { branch_id: true } } }, orderBy: { name: 'asc' }, take: 1001 }),
    db.scheduleResource.findMany({ where: { company_id: scope.companyId, branch_id: { in: branchIds } }, select: { id: true, name: true, type: true,portable:true, person_capacity: true, branch_id: true, active: true, version: true }, orderBy: { name: 'asc' }, take: 1001 }),
  ])
  if ([branches, providers, resources].some(rows => rows.length > 1000)) fail(400, 'DIRECTORY_LIMIT', 'Selecciona una sucursal con menos registros para configurar la agenda')
  let employeeCandidates = []
  if (configure && await hrEnabled(db, scope.companyId)) {
    const rows = await db.employee.findMany({ where: { company_id: scope.companyId, branch_id: { in: scope.branchIds }, status: 'ACTIVO' },
      select: { id: true, first_name: true, last_name: true, photo_url: true, photo_storage_path: true, branch_id: true }, orderBy: [{ last_name: 'asc' }, { id: 'asc' }], take: 1001 })
    if (rows.length > 1000) fail(400, 'DIRECTORY_LIMIT', 'Acota la selección de empleados por sucursal')
    const { employeeDto } = require('../hr/employeeApplication')
    employeeCandidates = await Promise.all(rows.map(async row => {
      if (row.photo_storage_path && !row.photo_storage_path.startsWith(`${scope.companyId}/employees/${row.id}/`)) row = { ...row, photo_storage_path: null, photo_url: null }
      let photo = null
      try { photo = (await employeeDto(row)).photo_url || null } catch { /* La foto no impide configurar el horario. */ }
      return { id: row.id, name: `${row.first_name} ${row.last_name}`, photoUrl: photo, branchId: row.branch_id }
    }))
  }
  const upcoming = configure ? await db.appointmentSession.findMany({ where: { company_id: scope.companyId, branch_id: { in: scope.branchIds }, starts_at: { gte: new Date() }, status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
    select: { providers: { select: { provider_id: true } }, resources: { select: { resource_id: true } } }, take: 5001 }) : []
  if (upcoming.length > 5000) fail(400, 'DIRECTORY_LIMIT', 'Hay demasiadas sesiones futuras; consulta la agenda por período')
  const providerCounts = new Map(), resourceCounts = new Map()
  for (const session of upcoming) {
    for (const item of session.providers) providerCounts.set(item.provider_id, (providerCounts.get(item.provider_id) || 0) + 1)
    for (const item of session.resources) resourceCounts.set(item.resource_id, (resourceCounts.get(item.resource_id) || 0) + 1)
  }
  return { timezone,branches, providers: providers.map(row => ({ id: row.id, name: row.name, employeeId: configure ? row.employee_id : null, userId: configure ? row.user_id : null, active: row.active, version: row.version, futureSessions: providerCounts.get(row.id) || 0,
    branchIds: row.branches.filter(branch => scope.branchIds.includes(branch.branch_id)).map(branch => branch.branch_id) })),
    resources: resources.map(row => ({ id: row.id, name: row.name, type: row.type,portable:row.portable, personCapacity: row.person_capacity, branchId: row.branch_id, active: row.active, version: row.version, futureSessions: resourceCounts.get(row.id) || 0 })), employeeCandidates }
}
module.exports = { listDirectory, saveProvider, saveResource, assertConfigure, hrEnabled, validateBranches }
