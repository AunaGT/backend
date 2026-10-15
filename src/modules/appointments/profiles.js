const { parseProfile, fail, uuid } = require('./domain/validation')
const { hasAgendaPermission, assertAgendaWrite, assertAppointmentsEnabled, assertCatalogIntegration } = require('./access')

const includeAssignments = { branches: true, providers: true, resources: true }
const fields = {
  enabled: 'enabled', mode: 'mode', schedulingStyle:'scheduling_style',durationPolicy:'duration_policy',durationMinutes: 'duration_minutes', beforeMinutes: 'before_minutes',
  completionPolicy:'completion_policy',
  afterMinutes: 'after_minutes', intervalMinutes: 'interval_minutes', leadMinutes: 'lead_minutes', horizonDays: 'horizon_days',
  cancellationHours: 'cancellation_hours', confirmation: 'confirmation', capacity: 'capacity',
  requiresProvider: 'requires_provider', requiresResource: 'requires_resource', instructions: 'instructions',publicInstructions:'public_instructions',allowedVenueKinds:'allowed_venue_kinds',
}
function presentProfile(row) {
  const profile = Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, row[column]]))
  profile.allowedVenueKinds??=['BRANCH']
  Object.assign(profile,require('./domain/servicePolicy').normalizeServicePolicy(profile))
  profile.branchIds = (row.branches || []).map(item => item.branch_id)
  profile.providerIds = (row.providers || []).map(item => item.provider_id)
  profile.resourceIds = (row.resources || []).map(item => item.resource_id)
  profile.expectedVersion = row.version
  return { profile, version: row.version }
}
async function serviceProduct(db, scope, productId) {
  uuid(productId, 'productId')
  await assertCatalogIntegration(db,scope)
  const product = await db.product.findFirst({ where: { id: productId, company_id: scope.companyId, deleted: false }, select: { id: true, kind: true } })
  if (!product) fail(404, 'NOT_FOUND', 'Servicio no encontrado')
  if (product.kind !== 'SERVICE') fail(400, 'NOT_SERVICE', 'La agenda solo puede configurarse en servicios')
  return product
}
async function getServiceProfile(db, scope, productId) {
  await assertAppointmentsEnabled(db, scope)
  await serviceProduct(db, scope, productId)
  const row = await db.serviceScheduleProfile.findFirst({ where: { company_id: scope.companyId, product_id: productId }, include: includeAssignments })
  return row ? presentProfile(row) : null
}
async function saveServiceProfile(tx, scope, productId, raw) {
  assertAgendaWrite(scope)
  if (!hasAgendaPermission(scope, 'appointments.configure')) fail(403, 'FORBIDDEN', 'No tienes permiso para configurar servicios')
  const input = parseProfile(raw)
  await assertAppointmentsEnabled(tx, scope)
  await serviceProduct(tx, scope, productId)
  const old = await tx.serviceScheduleProfile.findFirst({ where: { company_id: scope.companyId, product_id: productId }, include: { branches: true } })
  if (old?.branches?.some(b => !scope.branchIds.includes(b.branch_id))) fail(403, 'FORBIDDEN', 'La configuración es compartida; requiere acceso a todas sus sucursales')
  if (old && input.expectedVersion !== old.version) fail(409, 'STALE_VERSION', 'Otra persona cambió el servicio; vuelve a cargarlo')
  if (!old && input.expectedVersion != null && input.expectedVersion !== 0) fail(409, 'STALE_VERSION', 'La configuración aún no existe')
  if (input.branchIds.some(id => !scope.branchIds.includes(id))) fail(403, 'FORBIDDEN', 'Selecciona sucursales a las que tengas acceso')
  const [branches, providers, resources] = await Promise.all([
    tx.branch.findMany({ where: { id: { in: input.branchIds }, company_id: scope.companyId, active: true }, select: { id: true,name:true } }),
    tx.serviceProvider.findMany({ where: { id: { in: input.providerIds }, company_id: scope.companyId, active: true }, include: { branches: true } }),
    tx.scheduleResource.findMany({ where: { id: { in: input.resourceIds }, company_id: scope.companyId, active: true }, select: { id: true, branch_id: true,type:true,portable:true } }),
  ])
  const matches = (selected, rows) => selected.every(id => rows.some(row => row.id === id))
  if(input.enabled&&!input.branchIds.length) fail(400,'INVALID_ASSIGNMENTS','Selecciona una sucursal responsable',{branchIds:'Selecciona al menos una sucursal donde se ofrece'})
  if (!matches(input.branchIds, branches) || !matches(input.providerIds, providers) || !matches(input.resourceIds, resources)) {
    fail(400, 'INVALID_ASSIGNMENTS', 'Una sucursal, profesional o recurso ya no está disponible', { assignments: 'Revisa las asignaciones del servicio' })
  }
  if (resources.some(row => !input.branchIds.includes(row.branch_id))) fail(400, 'INVALID_ASSIGNMENTS', 'El recurso pertenece a otra sucursal')
  if(input.enabled) for(const branch of branches){
    const label=branch.name||branch.id
    if(input.requiresProvider&&!providers.some(p=>p.branches.some(b=>b.branch_id===branch.id)))
      fail(400,'INVALID_ASSIGNMENTS',`Falta profesional habilitado en ${label}`,{providerIds:`Selecciona un profesional para ${label}`})
    for(const kind of input.allowedVenueKinds) if(input.requiresResource&&!resources.some(r=>r.branch_id===branch.id&&(kind==='BRANCH'||(r.type==='EQUIPMENT'&&r.portable))))
      fail(400,'INVALID_ASSIGNMENTS',`Falta sala o equipo compatible en ${label}`,{resourceIds:`Selecciona un recurso compatible con ${kind==='BRANCH'?'sucursal':'atención externa'} en ${label}`})
  }
  const data = Object.fromEntries(Object.entries(fields).filter(([key])=>input[key]!==undefined).map(([key, column]) => [column, input[key]]))
  let row
  if (old) {
    const changed = await tx.serviceScheduleProfile.updateMany({ where: { id: old.id, company_id: scope.companyId, version: old.version }, data: { ...data, version: { increment: 1 } } })
    if (changed.count !== 1) fail(409, 'STALE_VERSION', 'Otra persona cambió el servicio; vuelve a cargarlo')
    row = { ...old, ...data, version: old.version + 1 }
  } else row = await tx.serviceScheduleProfile.create({ data: { ...data, company_id: scope.companyId, product_id: productId, created_by: scope.userId, version: 1 } })
  const assignments = [
    ['serviceScheduleBranch', 'branch_id', input.branchIds], ['serviceScheduleProvider', 'provider_id', input.providerIds], ['serviceScheduleResource', 'resource_id', input.resourceIds],
  ]
  for (const [model, key, selected] of assignments) {
    await tx[model].deleteMany({ where: { profile_id: row.id, company_id: scope.companyId } })
    if (selected.length) await tx[model].createMany({ data: selected.map(id => ({ profile_id: row.id, company_id: scope.companyId, [key]: id })) })
  }
  return { profile: { ...input, publicInstructions:row.public_instructions??'', expectedVersion: row.version }, version: row.version }
}
module.exports = { saveServiceProfile, getServiceProfile, presentProfile, serviceProduct }
