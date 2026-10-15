const { parseCalendar, uuid, choice, clock, fail } = require('./domain/validation')
const { assertAppointmentsEnabled } = require('./access')
const { assertConfigure } = require('./directory')
async function calendarOwner(db, scope, type, id, writing = false) {
  choice(type, 'ownerType', ['branch', 'provider', 'resource'])
  uuid(id, 'ownerId')
  const ids = scope.branchIds
  let owner
  if (type === 'branch') owner = ids.includes(id) ? await db.branch.findFirst({ where: { id, company_id: scope.companyId }, select: { id: true } }) : null
  if (type === 'resource') owner = await db.scheduleResource.findFirst({ where: { id, company_id: scope.companyId, branch_id: { in: ids } }, select: { id: true } })
  if (type === 'provider') {
    owner = await db.serviceProvider.findFirst({ where: { id, company_id: scope.companyId, branches: { some: { branch_id: { in: ids } } } }, include: { branches: true } })
    if (writing && owner?.branches.some(branch => !ids.includes(branch.branch_id))) fail(403, 'FORBIDDEN', 'El horario compartido necesita acceso a todas sus sucursales')
  }
  if (!owner) fail(404, 'NOT_FOUND', 'No se encontró el dueño de este horario en tu alcance')
  return { company_id: scope.companyId, owner_type: type, [`${type}_id`]: id }
}
const time = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
async function getCalendar(db, scope, type, id) {
  await assertAppointmentsEnabled(db, scope)
  const where = await calendarOwner(db, scope, type, id)
  const row = await db.scheduleCalendar.findFirst({ where, include: { rules: true, exceptions: true } })
  if (!row) return null
  return { timezone: row.timezone, expectedVersion: row.version, validFrom: row.valid_from?.toISOString().slice(0, 10) ?? null, validUntil: row.valid_until?.toISOString().slice(0, 10) ?? null,
    inheritBranch: row.inherit_branch, weekly: row.rules.map(rule => ({ weekday: rule.weekday, from: time(rule.from_minute), to: time(rule.to_minute) })),
    exceptions: row.exceptions.map(e => ({ date: e.local_date.toISOString().slice(0, 10), from: e.from_minute == null ? null : time(e.from_minute), to: e.to_minute == null ? null : time(e.to_minute), reason: e.reason })) }
}
async function saveCalendar(tx, scope, type, id, raw) {
  assertConfigure(scope)
  await assertAppointmentsEnabled(tx, scope)
  const input = parseCalendar(raw)
  const where = await calendarOwner(tx, scope, type, id, true)
  if (type === 'branch' && input.inheritBranch) fail(400, 'INVALID_INHERITANCE', 'La sucursal debe definir su propio horario')
  const old = await tx.scheduleCalendar.findFirst({ where })
  if ((old?.version ?? 0) !== input.expectedVersion) fail(409, 'STALE_VERSION', 'Otra persona cambió este horario; vuelve a cargarlo')
  const data = { timezone: input.timezone, valid_from: input.validFrom ? new Date(`${input.validFrom}T00:00:00Z`) : null,
    valid_until: input.validUntil ? new Date(`${input.validUntil}T00:00:00Z`) : null, inherit_branch: input.inheritBranch }
  let row
  if (old) {
    const changed = await tx.scheduleCalendar.updateMany({ where: { id: old.id, company_id: scope.companyId, version: old.version }, data: { ...data, version: { increment: 1 } } })
    if (changed.count !== 1) fail(409, 'STALE_VERSION', 'Otra persona cambió este horario; vuelve a cargarlo')
    row = { id: old.id, version: old.version + 1 }
  } else row = await tx.scheduleCalendar.create({ data: { ...where, ...data } })
  await tx.availabilityRule.deleteMany({ where: { calendar_id: row.id, company_id: scope.companyId } })
  await tx.availabilityException.deleteMany({ where: { calendar_id: row.id, company_id: scope.companyId } })
  if (input.weekly.length) await tx.availabilityRule.createMany({ data: input.weekly.map(rule => ({ company_id: scope.companyId, calendar_id: row.id, weekday: rule.weekday, from_minute: clock(rule.from, 'from'), to_minute: clock(rule.to, 'to', true) })) })
  if (input.exceptions.length) await tx.availabilityException.createMany({ data: input.exceptions.map(e => ({ company_id: scope.companyId, calendar_id: row.id,
    local_date: new Date(`${e.date}T00:00:00Z`), from_minute: e.from == null ? null : clock(e.from, 'from'), to_minute: e.to == null ? null : clock(e.to, 'to', true), reason: e.reason })) })
  return { version: row.version }
}
module.exports = { calendarOwner, getCalendar, saveCalendar }
