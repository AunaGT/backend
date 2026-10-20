const { parseAvailability, parseFilter, fail, uuid, integer, text } = require('./domain/validation')
const { assertAppointmentsEnabled, assertAgendaWrite, hasAgendaPermission, appointmentWhere,agendaCapabilities,assertCatalogIntegration,assertContactsIntegration } = require('./access')
const { presentProfile } = require('./profiles')
const { computeSlots, ABSENCES, calendarWindows, assigned, overlaps } = require('./domain/availability')
const { resolveEffectiveModules } = require('../platform/registry')
const { presentBooking, presentSession, authorizedIncludes } = require('./presentation')
const { contactImageDtos } = require('../contacts/imageStorage')
const { DateTime } = require('luxon')
const {resolveBusyIdentities,loadBusyAssignments}=require('./occupancy')

async function availabilityContext(db, scope, raw, { excludeSessionId, profileOverride } = {}) {
  assertAgendaWrite(scope)
  const input = parseAvailability(raw)
  await assertAppointmentsEnabled(db, scope)
  const historical=!!profileOverride&&!!excludeSessionId
  if(!historical) await assertCatalogIntegration(db,scope)
  const row = historical?{enabled:true,branches:[{branch_id:scope.branchId}],providers:(profileOverride.providerIds||input.providerIds).map(provider_id=>({provider_id})),resources:(profileOverride.resourceIds||input.resourceIds).map(resource_id=>({resource_id})),product:{id:input.productId,kind:'SERVICE',available_for_sale:true}}:
    await db.serviceScheduleProfile.findFirst({ where: { company_id: scope.companyId, product_id: input.productId }, include: { branches: true, providers: true, resources: true, product: true } })
  if (!row || !row.enabled || !row.branches.some(b => b.branch_id === scope.branchId) || row.product.deleted || row.product.kind !== 'SERVICE' || !row.product.available_for_sale) fail(409, 'SERVICE_UNAVAILABLE', 'El servicio no está habilitado para reservar en esta sucursal')
  let profile = require('./domain/servicePolicy').normalizeServicePolicy(profileOverride || presentProfile(row).profile)
  if(input.durationMinutes!==undefined){
    if(profile.durationPolicy==='FIXED'&&input.durationMinutes!==profile.durationMinutes) fail(400,'INVALID_DURATION','La duración del servicio es fija',{durationMinutes:'Usa la duración fija configurada'})
    profile={...profile,durationMinutes:input.durationMinutes}
  }
  if(!(profile.allowedVenueKinds||['BRANCH']).includes(input.venue.kind)) fail(400,'VENUE_NOT_ALLOWED','El servicio no admite este lugar de atención')
  const [providers, resources] = await Promise.all([
    db.serviceProvider.findMany({ where: { company_id: scope.companyId, id: { in: profile.providerIds||row.providers.map(p => p.provider_id) }, active: true, branches: { some: { branch_id: scope.branchId } },
      ...(!hasAgendaPermission(scope, 'appointments.view_team') ? { OR: [{ user_id: scope.userId }, { employee: { user_id: scope.userId } }] } : {}) },
    select: { id: true, employee_id: true, user_id: true } }),
    db.scheduleResource.findMany({ where: { company_id: scope.companyId, id: { in: profile.resourceIds||row.resources.map(r => r.resource_id) }, branch_id: scope.branchId, active: true }, select: { id: true, person_capacity: true,type:true,portable:true } }),
  ])
  if (input.providerIds.some(id => !providers.some(p => p.id === id)) || input.resourceIds.some(id => !resources.some(r => r.id === id))) fail(400, 'INVALID_ASSIGNMENTS', 'Revisa los profesionales y recursos disponibles')
  require('./domain/activities').validateVenueAssignments(input.venue,resources.filter(r=>input.resourceIds.includes(r.id)),null)
  const from = new Date(new Date(input.from).getTime() - 172800000), to = new Date(new Date(input.to).getTime() + 172800000)
  const identities=await resolveBusyIdentities(db,scope,{providerIds:providers.map(p=>p.id)})
  const [calendars, busyAssignments, modules] = await Promise.all([
    db.scheduleCalendar.findMany({ where: { company_id: scope.companyId, OR: [{ branch_id: scope.branchId }, { provider_id: { in: providers.map(p => p.id) } }, { resource_id: { in: resources.map(r => r.id) } }] }, include: { rules: true, exceptions: true } }),
    loadBusyAssignments(db,scope,{from,to,identities,resourceIds:resources.map(r=>r.id),excludeSessionId,
      includeGroups:{branchId:scope.branchId,productId:input.productId}}),
    db.companyModule.findMany({ where: { company_id: scope.companyId } }),
  ])
  const sessions=busyAssignments.map(block=>block.session)
  const employees = providers.map(p => p.employee_id).filter(Boolean)
  const absenceDates = employees.length && resolveEffectiveModules(modules).find(m => m.code === 'hr')?.effectiveEnabled
    ? await db.attendance.findMany({ where: { company_id: scope.companyId, employee_id: { in: employees }, work_date: { gte: from, lte: to }, status: { in: ABSENCES } }, select: { employee_id: true, work_date: true, status: true } }) : []
  const timezone=calendars.find(c=>c.owner_type==='branch')?.timezone||(await db.systemSetting.findUnique({where:{company_id_key:{company_id:scope.companyId,key:'timezone'}}}))?.value||'America/Guatemala'
  return { input,timezone,branchId:scope.branchId,...{venue:input.venue,outboundMinutes:input.outboundMinutes,returnMinutes:input.returnMinutes}, productId: input.productId, product: row.product, profile, calendars, providers,
    resources:input.venue.kind==='BRANCH'?resources:resources.filter(r=>r.type!=='ROOM'&&r.portable), sessions,busyAssignments, bookings: sessions.flatMap(s => s.bookings), absenceDates, from: input.from, to: input.to,
    providerIds: input.providerIds, resourceIds: input.resourceIds }
}
async function readAvailability(db, scope, raw, now = new Date(), options = {}) {
  const context = await availabilityContext(db, scope, raw, options)
  return computeSlots({ ...context, now, scheduleGroup: options.scheduleGroup || false })
}
async function readSessionAvailability(db, scope, raw) {
  if (!hasAgendaPermission(scope, 'appointments.create')) fail(403, 'FORBIDDEN', 'No tienes permiso para programar sesiones')
  const context = await availabilityContext(db, scope, raw)
  if (context.profile.mode !== 'GROUP') fail(400, 'NOT_GROUP', 'Selecciona un servicio grupal')
  return computeSlots({ ...context, now: new Date(), scheduleGroup: true })
}
async function readMoveAvailability(db, scope, kind, id, raw) {
  if (!hasAgendaPermission(scope, 'appointments.edit')) fail(403, 'FORBIDDEN', 'No tienes permiso para reprogramar')
  await assertAppointmentsEnabled(db, scope)
  const { loadBooking, loadSession } = require('./application')
  const session = kind === 'booking' ? (await loadBooking(db, scope, id)).session : await loadSession(db, scope, id)
  const input = parseAvailability(raw)
  if (session.product_id !== input.productId) fail(400, 'SERVICE_MISMATCH', 'No puedes cambiar el servicio al reprogramar')
  if (session.status !== 'SCHEDULED' || session.starts_at <= new Date()) fail(409, 'SESSION_STARTED', 'La sesión ya no puede reprogramarse')
  return readAvailability(db, scope, input, new Date(), { excludeSessionId: session.id, profileOverride: { ...session.policy_snapshot, capacity: session.capacity }, scheduleGroup: session.mode === 'GROUP' })
}
async function listContacts(db, scope, query = {}) {
  await assertAppointmentsEnabled(db, scope)
  await assertContactsIntegration(db,scope)
  if (!hasAgendaPermission(scope, 'appointments.create')) fail(403, 'FORBIDDEN', 'No tienes permiso para seleccionar clientes')
  const page = integer(query.page ?? 1, 'page', 1, 1000000, true), q = text(query.q, 'q', 150, false)
  const where = { company_id: scope.companyId, party_type: 'CUSTOMER', deleted: false, estado: 1, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }
  const [items, totalItems] = await Promise.all([db.supplier.findMany({ where, select: { id: true, name: true,address:true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 10, skip: (page - 1) * 10 }), db.supplier.count({ where })])
  return { items, totalItems, page, pageSize: 10 }
}
function statusWhere(status, now = new Date()) {
  if (status === 'EXPIRED') return { OR: [{ status: 'EXPIRED' }, { status: { in: ['HELD', 'PENDING'] }, expires_at: { lte: now } }] }
  if (['HELD', 'PENDING'].includes(status)) return { status, expires_at: { gt: now } }
  return status ? { status } : {}
}
function filterWhere(scope, filter, now, capabilities={catalog:true,contacts:true}) {
  const session = { ...appointmentWhere(scope), starts_at: { lt: new Date(filter.to) }, ends_at: { gt: new Date(filter.from) },
    record_type:'SCHEDULED_SERVICE',
    ...(filter.productId ? { product_id: filter.productId } : {}), ...(filter.resourceId ? { resources: { some: { resource_id: filter.resourceId } } } : {}) }
  if (filter.providerId) session.AND = [{ providers: { some: { provider_id: filter.providerId } } }]
  const booking = { company_id: scope.companyId, session, AND: [statusWhere(filter.status, now)] }
  const contacts=capabilities.contacts&&hasAgendaPermission(scope,'contacts.clients.view')
  const catalog=capabilities.catalog&&hasAgendaPermission(scope,'products.view')
  if (filter.q) booking.AND.push({ OR: [...(contacts?[{ contact: { name: { contains: filter.q, mode: 'insensitive' } } }]:[]),
    ...(catalog?[{ session: { product: { name: { contains: filter.q, mode: 'insensitive' } } } }]:[])] })
  if (filter.status) session.AND = [...(session.AND || []), { bookings: { some: statusWhere(filter.status, now) } }]
  if (filter.q) session.AND = [...(session.AND || []), { OR: [...(catalog?[{ product: { name: { contains: filter.q, mode: 'insensitive' } } }]:[]),
    ...(contacts?[{ bookings: { some: { contact: { name: { contains: filter.q, mode: 'insensitive' } } } } }]:[])] }]
  return { session, booking }
}
async function addConflicts(db, scope, rows) {
  if (!rows.length) return rows
  const providerIds = [...new Set(rows.flatMap(s => assigned(s, 'providers')))], resourceIds = [...new Set(rows.flatMap(s => assigned(s, 'resources')))], branchIds = [...new Set(rows.map(s => s.branch_id))]
  const lower = Math.min(...rows.map(s => s.occupied_from.getTime())), upper = Math.max(...rows.map(s => s.occupied_until.getTime()))
  const [calendars, providers, resources, modules] = await Promise.all([
    db.scheduleCalendar.findMany({ where: { company_id: scope.companyId, OR: [{ branch_id: { in: branchIds } }, { provider_id: { in: providerIds } }, { resource_id: { in: resourceIds } }] }, include: { rules: true, exceptions: true } }),
    db.serviceProvider.findMany({ where: { company_id: scope.companyId, id: { in: providerIds } }, select: { id: true,user_id:true, active: true, employee_id: true, branches: { select: { branch_id: true } } } }),
    db.scheduleResource.findMany({ where: { company_id: scope.companyId, id: { in: resourceIds } }, select: { id: true, active: true, branch_id: true, person_capacity: true } }),
    db.companyModule.findMany({ where: { company_id: scope.companyId } }),
  ])
  const userIds=[...new Set(rows.flatMap(r=>[r.organizer_id,...(r.participants||[]).map(p=>p.user_id)]).concat(providers.map(p=>p.user_id)).filter(Boolean))]
  const people=userIds.length&&resolveEffectiveModules(modules).find(m=>m.code==='hr')?.effectiveEnabled
    ? await db.employee.findMany({where:{company_id:scope.companyId,user_id:{in:userIds}},select:{id:true,user_id:true}}):[]
  const employeeIds = [...new Set([...providers.map(p => p.employee_id),...people.map(p=>p.id)].filter(Boolean))]
  const absences = employeeIds.length && resolveEffectiveModules(modules).find(m => m.code === 'hr')?.effectiveEnabled
    ? await db.attendance.findMany({ where: { company_id: scope.companyId, employee_id: { in: employeeIds }, work_date: { gte: new Date(lower - 172800000), lte: new Date(upper + 172800000) }, status: { in: ABSENCES } }, select: { employee_id: true, work_date: true } }) : []
  const cached = new Map()
  return rows.map(row => {
    const conflicts = []
    if (row.product?.deleted || row.product?.available_for_sale === false) conflicts.push('Servicio archivado o no disponible para venta')
    if (row.product?.service_schedule_profile?.enabled === false) conflicts.push('Agenda del servicio deshabilitada')
    const branch = calendars.find(c => c.branch_id === row.branch_id)
    const interval = { start: row.occupied_from.getTime(), end: row.occupied_until.getTime() }
    const calendarsToCheck = [...((row.venue?.kind||'BRANCH')==='BRANCH'?[branch]:[]), ...assigned(row, 'providers').map(id => calendars.find(c => c.provider_id === id)), ...assigned(row, 'resources').map(id => calendars.find(c => c.resource_id === id))]
    if (calendarsToCheck.some(c => {
      if (!c) return row.record_type!=='ACTIVITY'
      const key = `${c.id}:${row.branch_id}`
      if (!cached.has(key)) cached.set(key, calendarWindows(c, branch, lower, upper))
      return !cached.get(key).some(w => w.start <= interval.start && w.end >= interval.end)
    })) conflicts.push('Fuera del horario configurado actualmente')
    const activityUsers=[row.organizer_id,...(row.participants||[]).map(p=>p.user_id)]
    if(row.record_type==='ACTIVITY'&&absences.some(a=>{
      if(!people.some(p=>p.id===a.employee_id&&activityUsers.includes(p.user_id))) return false
      const day=DateTime.fromISO(a.work_date.toISOString().slice(0,10),{zone:row.timezone})
      return overlaps(interval,{start:day.toMillis(),end:day.plus({days:1}).toMillis()})
    })) conflicts.push('Ausencia registrada del personal')
    for (const id of assigned(row, 'providers')) {
      const p = providers.find(p => p.id === id)
      if (!p?.active || !p.branches.some(b => b.branch_id === row.branch_id)) conflicts.push('Profesional deshabilitado o reasignado')
      const zone = calendars.find(c => c.provider_id === id)?.timezone || row.timezone
      if (absences.some(a => {
        if (a.employee_id !== p?.employee_id) return false
        const day = DateTime.fromISO(a.work_date.toISOString().slice(0, 10), { zone })
        return overlaps(interval, { start: day.toMillis(), end: day.plus({ days: 1 }).toMillis() })
      })) conflicts.push('Ausencia registrada del profesional')
    }
    if (assigned(row, 'resources').some(id => { const r = resources.find(r => r.id === id); return !r?.active || r.branch_id !== row.branch_id || (r.person_capacity != null && r.person_capacity < row.capacity) })) conflicts.push('Recurso deshabilitado o capacidad insuficiente')
    return { ...row, conflicts: [...new Set(conflicts)] }
  })
}
async function bookingDtos(db, scope, rows) {
  const sessions = await addConflicts(db, scope, [...new Map(rows.map(r => [r.session_id, r.session])).values()])
  const inputs=rows.map(r=>r.contact).filter(Boolean)
  const contacts = inputs.length ? await contactImageDtos(inputs, scope.companyId) : []
  return rows.map(r => presentBooking({ ...r, contact: contacts.find(c=>c.id===r.contact_id), conflicts: sessions.find(s => s.id === r.session_id)?.conflicts || [] }, scope))
}
async function listBookings(db, scope, raw) {
  await assertAppointmentsEnabled(db, scope)
  const capabilities=await agendaCapabilities(db,scope), include=authorizedIncludes(capabilities,scope).booking
  const filter = parseFilter(raw), where = filterWhere(scope, filter, new Date(),capabilities).booking
  const [totalItems, rows] = await Promise.all([db.appointmentBooking.count({ where }), db.appointmentBooking.findMany({ where, include, orderBy: [{ session: { starts_at: 'asc' } }, { id: 'asc' }], skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize })])
  return { items: await bookingDtos(db, scope, rows), totalItems, page: filter.page, pageSize: filter.pageSize }
}
async function listSessions(db, scope, raw) {
  await assertAppointmentsEnabled(db, scope)
  const capabilities=await agendaCapabilities(db,scope), include=authorizedIncludes(capabilities,scope).session
  const filter = parseFilter(raw), where = filterWhere(scope, filter, new Date(),capabilities).session
  const [totalItems, rows] = await Promise.all([db.appointmentSession.count({ where }), db.appointmentSession.findMany({ where, include, orderBy: [{ starts_at: 'asc' }, { id: 'asc' }], skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize })])
  return { items: (await addConflicts(db, scope, rows)).map(r => presentSession(r, scope)), totalItems, page: filter.page, pageSize: filter.pageSize }
}
async function readSummary(db, scope, raw) {
  await assertAppointmentsEnabled(db, scope)
  const capabilities=await agendaCapabilities(db,scope)
  const filter = parseFilter(raw), now = new Date(), base = filterWhere(scope, filter, now,capabilities).booking
  const names = { pending: 'PENDING', arrived: 'ARRIVED', inService: 'IN_SERVICE', noShow: 'NO_SHOW' }
  const [reservations, ...values] = await Promise.all([db.appointmentBooking.count({ where: base }), ...Object.values(names).map(status => db.appointmentBooking.count({ where: { AND: [base, statusWhere(status, now)] } }))])
  return { reservations, ...Object.fromEntries(Object.keys(names).map((name, i) => [name, values[i]])) }
}
async function getBooking(db, scope, id) {
  uuid(id, 'bookingId'); await assertAppointmentsEnabled(db, scope)
  const include=authorizedIncludes(await agendaCapabilities(db,scope),scope).booking
  const row = await db.appointmentBooking.findFirst({ where: { id, company_id: scope.companyId, session: appointmentWhere(scope) }, include })
  if (!row) fail(404, 'NOT_FOUND', 'Reserva no encontrada')
  const [dto] = await bookingDtos(db, scope, [row])
  return { ...dto, history: await readHistory(db, scope, { booking_id: id }) }
}
async function readHistory(db, scope, target) {
  const rows = await db.appointmentHistory.findMany({ where: { company_id: scope.companyId, ...target }, select: { id: true, action: true, created_at: true, reason: true, actor: { select: { name: true } } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 101 })
  return { items: rows.slice(0, 100).map(r => ({ id: r.id, action: r.action, at: r.created_at.toISOString(), actor: r.actor?.name||'Sistema',
    reason: hasAgendaPermission(scope, 'appointments.attend') || hasAgendaPermission(scope, 'appointments.configure') ? r.reason : null })), hasMore: rows.length > 100 }
}
async function getSession(db, scope, id, query = {}) {
  uuid(id, 'sessionId'); await assertAppointmentsEnabled(db, scope)
  const includes=authorizedIncludes(await agendaCapabilities(db,scope),scope)
  const row = await db.appointmentSession.findFirst({ where: { id, ...appointmentWhere(scope),record_type:'SCHEDULED_SERVICE' }, include:includes.session })
  if (!row) fail(404, 'NOT_FOUND', 'Sesión no encontrada')
  const page = integer(query.page ?? 1, 'page', 1, 1000000, true), waitPage = integer(query.waitPage ?? 1, 'waitPage', 1, 1000000, true)
  const pageSize = integer(query.pageSize ?? 10, 'pageSize', 1, 100, true)
  const where = { company_id: scope.companyId, session_id: id }
  const q = text(query.q, 'q', 150, false), bookingWhere = { ...where, ...(q ? includes.contact ? { contact: { name: { contains: q, mode: 'insensitive' } } } : {OR:[]} : {}) }
  const [rows, totalItems, waitlist, waitTotal, enriched] = await Promise.all([
    db.appointmentBooking.findMany({ where: bookingWhere, include: includes.booking, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: pageSize, skip: (page - 1) * pageSize }), db.appointmentBooking.count({ where: bookingWhere }),
    db.appointmentWaitlist.findMany({ where: { ...where, status: 'WAITING' }, select: { id: true, contact_id: true, created_at: true, ...(includes.contact?{contact:{select:{name:true}}}:{}) }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: pageSize, skip: (waitPage - 1) * pageSize }), db.appointmentWaitlist.count({ where: { ...where, status: 'WAITING' } }), addConflicts(db, scope, [row]),
  ])
  return { ...presentSession(enriched[0], scope), bookings: { items: await bookingDtos(db, scope, rows), page, pageSize, totalItems },
    waitlist: { items: waitlist.map(w => ({ id: w.id, contactId: w.contact_id, contactName: w.contact?.name||'', createdAt: w.created_at.toISOString() })), page: waitPage, pageSize, totalItems: waitTotal }, history: await readHistory(db, scope, { session_id: id }) }
}
async function listServices(db, scope, query = {}) {
  await assertAppointmentsEnabled(db, scope)
  await assertCatalogIntegration(db,scope)
  const page = integer(query.page ?? 1, 'page', 1, 1000000, true), q = text(query.q, 'q', 150, false)
  const pageSize = integer(query.pageSize ?? 10, 'pageSize', 1, 100, true)
  const where = { company_id: scope.companyId, kind: 'SERVICE', deleted: false, ...(query.id ? { id: uuid(query.id, 'productId') } : {}), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }
  const [rows, totalItems] = await Promise.all([db.product.findMany({ where, select: { id: true, name: true, price: true, available_for_sale: true, service_unit_label: true, quantity_decimals: true, service_schedule_profile: {include:{branches:true,providers:true,resources:true}} }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: pageSize, skip: (page - 1) * pageSize }), db.product.count({ where })])
  return { page, pageSize, totalItems, items: rows.map(r => ({ id: r.id, name: r.name,
    price: hasAgendaPermission(scope, 'products.view') ? r.price.toFixed(2) : null, unit: r.service_unit_label, quantityDecimals: r.quantity_decimals, available: r.available_for_sale,
    confirmation: r.service_schedule_profile?.confirmation || 'AUTOMATIC', schedulable: !!r.service_schedule_profile?.enabled && r.service_schedule_profile.branches.some(b => b.branch_id === scope.branchId), mode: r.service_schedule_profile?.mode || 'INDIVIDUAL', durationMinutes: r.service_schedule_profile?.duration_minutes || null, capacity: r.service_schedule_profile?.capacity || 1,
    ...Object.fromEntries(['schedulingStyle','durationPolicy','completionPolicy','requiresProvider','requiresResource','providerIds','resourceIds','allowedVenueKinds','beforeMinutes','afterMinutes'].map(key=>[key,r.service_schedule_profile?presentProfile(r.service_schedule_profile).profile[key]:undefined])) })) }
}
module.exports = { readAvailability, readSessionAvailability, readMoveAvailability, listContacts, availabilityContext, filterWhere, statusWhere, listBookings, listSessions, readSummary, getBooking, getSession, listServices, addConflicts }
