const { DateTime, IANAZone } = require('luxon')
const BOOKING_STATUSES = ['HELD', 'PENDING', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'EXPIRED']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(status, code, message, fields) {
  throw Object.assign(new Error(message), { status, code, ...(fields ? { fields } : {}) })
}
function invalid(key, message) { fail(400, 'INVALID_INPUT', message, { [key]: message }) }
function object(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('form', 'Envía un objeto válido')
  for (const key of Object.keys(raw)) if (!keys.includes(key)) invalid(key, `El campo ${key} no está permitido`)
  return raw
}
function text(raw, key, max, required = true) {
  if (raw === undefined && !required) return ''
  if (typeof raw !== 'string') invalid(key, 'Ingresa un texto válido')
  const value = raw.trim()
  if ((required && !value) || value.length > max) invalid(key, `Ingresa hasta ${max} caracteres${required ? ' sin dejarlo vacío' : ''}`)
  return value
}
function integer(raw, key, min, max, query = false) {
  const value = query && typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
  if (!Number.isInteger(value) || value < min || value > max) invalid(key, `${key} debe estar entre ${min} y ${max}`)
  return value
}
function boolean(raw, key) { if (typeof raw !== 'boolean') invalid(key, 'Selecciona sí o no'); return raw }
function choice(raw, key, values) { if (!values.includes(raw)) invalid(key, `Selecciona una opción válida de ${key}`); return raw }
function uuid(raw, key) { if (typeof raw !== 'string' || !UUID.test(raw)) invalid(key, 'Selecciona un registro válido'); return raw }
function ids(raw, key) {
  if (!Array.isArray(raw) || raw.length > 100) invalid(key, 'Selecciona hasta 100 registros')
  return [...new Set(raw.map(value => uuid(value, key)))]
}
function zone(raw) { if (typeof raw !== 'string' || !IANAZone.isValidZone(raw)) invalid('timezone', 'Selecciona una zona horaria válida'); return raw }
function instant(raw, key) {
  if (typeof raw !== 'string' || !/T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) invalid(key, 'La fecha debe incluir hora y zona horaria')
  const value = DateTime.fromISO(raw, { setZone: true })
  if (!value.isValid) invalid(key, 'La fecha no es válida')
  return value.toUTC().toISO()
}
function localDate(raw, key) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !DateTime.fromISO(raw, { zone: 'UTC' }).isValid) invalid(key, 'Ingresa una fecha válida')
  return raw
}
function clock(raw, key, end = false) {
  if (end && raw === '24:00') return 1440
  if (typeof raw !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) invalid(key, 'Ingresa una hora válida')
  const [hour, minute] = raw.split(':').map(Number)
  return hour * 60 + minute
}
function quantity(raw) {
  if (typeof raw !== 'string' || raw.length > 13 || !/^\d{1,8}(?:\.\d{1,4})?$/.test(raw) || !/[1-9]/.test(raw)) invalid('quantity', 'Ingresa una cantidad positiva con hasta cuatro decimales')
  return raw
}
function version(raw, initial = false) { return integer(raw, 'expectedVersion', initial ? 0 : 1, 2147483647) }
function requestKey(raw) {
  const value = text(raw, 'idempotencyKey', 100)
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(value)) invalid('idempotencyKey', 'Identificador de intento no válido')
  return value
}
function parseProfile(raw) {
  const keys = ['enabled', 'mode', 'durationMinutes', 'beforeMinutes', 'afterMinutes', 'intervalMinutes', 'leadMinutes', 'horizonDays', 'cancellationHours', 'confirmation', 'capacity', 'requiresProvider', 'requiresResource', 'branchIds', 'providerIds', 'resourceIds', 'instructions', 'publicInstructions', 'expectedVersion','allowedVenueKinds','schedulingStyle','durationPolicy']
  const v = object(raw, [...keys,'completionPolicy'])
  const schedulingStyle=choice(v.schedulingStyle??(v.mode==='GROUP'?'CLASS':'APPOINTMENT'),'schedulingStyle',['APPOINTMENT','CLASS','WORK'])
  if((schedulingStyle==='CLASS')!==(v.mode==='GROUP')) invalid('schedulingStyle','El tipo de programación no coincide con los cupos')
  const kinds=v.allowedVenueKinds??['BRANCH']
  if(!Array.isArray(kinds)||!kinds.length||kinds.length>4) invalid('allowedVenueKinds','Selecciona al menos un lugar')
  const out = {schedulingStyle,durationPolicy:choice(v.durationPolicy??'FIXED','durationPolicy',['FIXED','EDITABLE']),allowedVenueKinds:[...new Set(kinds.map(k=>choice(k,'allowedVenueKinds',['BRANCH','HOME','EVENT_VENUE','ONLINE'])))],
    enabled: boolean(v.enabled, 'enabled'), mode: choice(v.mode, 'mode', ['INDIVIDUAL', 'GROUP']),
    durationMinutes: integer(v.durationMinutes, 'durationMinutes', 1, schedulingStyle==='WORK'?44640:1440),
    beforeMinutes: integer(v.beforeMinutes, 'beforeMinutes', 0, 1440), afterMinutes: integer(v.afterMinutes, 'afterMinutes', 0, 1440),
    intervalMinutes: integer(v.intervalMinutes, 'intervalMinutes', 1, 1440), leadMinutes: integer(v.leadMinutes, 'leadMinutes', 0, 525600),
    horizonDays: integer(v.horizonDays, 'horizonDays', 1, 365), cancellationHours: integer(v.cancellationHours, 'cancellationHours', 0, 8760),
    confirmation: choice(v.confirmation, 'confirmation', ['AUTOMATIC', 'MANUAL']), capacity: integer(v.capacity, 'capacity', 1, 10000),
    requiresProvider: boolean(v.requiresProvider, 'requiresProvider'), requiresResource: boolean(v.requiresResource, 'requiresResource'),
    branchIds: ids(v.branchIds, 'branchIds'), providerIds: ids(v.providerIds, 'providerIds'), resourceIds: ids(v.resourceIds, 'resourceIds'),
    instructions: text(v.instructions, 'instructions', 2000, false),
  }
  if (out.mode === 'INDIVIDUAL' && out.capacity !== 1) invalid('capacity', 'Una cita individual tiene un cupo')
  out.completionPolicy=choice(v.completionPolicy??'MANUAL','completionPolicy',['MANUAL','AUTO'])
  if(out.completionPolicy==='AUTO'&&schedulingStyle!=='WORK')invalid('completionPolicy','Las citas y clases requieren cierre manual')
  if (v.publicInstructions !== undefined) out.publicInstructions=text(v.publicInstructions,'publicInstructions',2000,false)
  if (v.expectedVersion !== undefined) out.expectedVersion = version(v.expectedVersion, true)
  return out
}
function parseBooking(raw) {
  const v = object(raw, ['productId', 'contactId', 'startsAt', 'endsAt', 'timezone', 'providerIds', 'resourceIds', 'quantity', 'notes', 'idempotencyKey','venue','outboundMinutes','returnMinutes'])
  return { ...parseLocation(v),...optionalEnd(v), productId: uuid(v.productId, 'productId'), contactId: uuid(v.contactId, 'contactId'), startsAt: instant(v.startsAt, 'startsAt'), timezone: zone(v.timezone),
    providerIds: ids(v.providerIds, 'providerIds'), resourceIds: ids(v.resourceIds, 'resourceIds'), quantity: quantity(v.quantity),
    notes: text(v.notes, 'notes', 2000, false), idempotencyKey: requestKey(v.idempotencyKey) }
}
function parseSession(raw) {
  const v = object(raw, ['productId', 'startsAt', 'endsAt', 'timezone', 'providerIds', 'resourceIds', 'capacity', 'notes', 'idempotencyKey','venue','outboundMinutes','returnMinutes'])
  return { ...parseLocation(v),...optionalEnd(v), productId: uuid(v.productId, 'productId'), startsAt: instant(v.startsAt, 'startsAt'), timezone: zone(v.timezone),
    providerIds: ids(v.providerIds, 'providerIds'), resourceIds: ids(v.resourceIds, 'resourceIds'), capacity: integer(v.capacity, 'capacity', 1, 10000),
    notes: text(v.notes, 'notes', 2000, false), idempotencyKey: requestKey(v.idempotencyKey) }
}
function parseEnroll(raw) {
  const v = object(raw, ['contactId', 'quantity', 'notes', 'idempotencyKey'])
  return { contactId: uuid(v.contactId, 'contactId'), quantity: quantity(v.quantity), notes: text(v.notes, 'notes', 2000, false), idempotencyKey: requestKey(v.idempotencyKey) }
}
function parseMove(raw) {
  const v = object(raw, ['startsAt', 'endsAt', 'timezone', 'providerIds', 'resourceIds', 'expectedVersion', 'idempotencyKey', 'reason','venue','outboundMinutes','returnMinutes'])
  return { ...parseLocation(v),...optionalEnd(v), startsAt: instant(v.startsAt, 'startsAt'), timezone: zone(v.timezone), providerIds: ids(v.providerIds, 'providerIds'), resourceIds: ids(v.resourceIds, 'resourceIds'),
    expectedVersion: version(v.expectedVersion), idempotencyKey: requestKey(v.idempotencyKey), reason: text(v.reason, 'reason', 500) }
}
function parseTransition(raw, session = false) {
  const v = object(raw, ['action', 'expectedVersion', 'idempotencyKey', 'reason'])
  const action = choice(v.action, 'action', session ? ['START', 'COMPLETE', 'CANCEL'] : ['CONFIRM', 'ARRIVE', 'START', 'COMPLETE', 'NO_SHOW', 'CANCEL'])
  return { action, expectedVersion: version(v.expectedVersion), idempotencyKey: requestKey(v.idempotencyKey), reason: text(v.reason, 'reason', 500, action === 'CANCEL') }
}
function parseCalendar(raw) {
  const v = object(raw, ['timezone', 'expectedVersion', 'validFrom', 'validUntil', 'inheritBranch', 'weekly', 'exceptions'])
  if (!Array.isArray(v.weekly) || v.weekly.length > 100) invalid('weekly', 'Ingresa hasta 100 intervalos')
  if (!Array.isArray(v.exceptions) || v.exceptions.length > 366) invalid('exceptions', 'Ingresa hasta 366 excepciones')
  const weekly = v.weekly.map(rawRule => {
    const r = object(rawRule, ['weekday', 'from', 'to'])
    const weekday = integer(r.weekday, 'weekday', 1, 7)
    if (clock(r.from, 'from') >= clock(r.to, 'to', true)) invalid('weekly', 'El intervalo debe terminar después de comenzar; divide los turnos nocturnos')
    return { weekday, from: r.from, to: r.to }
  })
  for (let i = 0; i < weekly.length; i++) for (let j = i + 1; j < weekly.length; j++) {
    const a = weekly[i], b = weekly[j]
    if (a.weekday === b.weekday && clock(a.from, 'from') < clock(b.to, 'to', true) && clock(b.from, 'from') < clock(a.to, 'to', true)) invalid('weekly', 'Los intervalos del mismo día no deben superponerse')
  }
  const exceptions = v.exceptions.map(rawException => {
    const e = object(rawException, ['date', 'from', 'to', 'reason'])
    const date = localDate(e.date, 'date')
    if (e.from !== null || e.to !== null) {
      if (e.from === null || e.to === null || clock(e.from, 'from') >= clock(e.to, 'to', true)) invalid('exceptions', 'Completa el intervalo de la excepción')
    }
    return { date, from: e.from, to: e.to, reason: text(e.reason, 'reason', 500, false) }
  })
  const validFrom = v.validFrom == null ? null : localDate(v.validFrom, 'validFrom')
  const validUntil = v.validUntil == null ? null : localDate(v.validUntil, 'validUntil')
  if (validFrom && validUntil && validFrom > validUntil) invalid('validUntil', 'La vigencia termina antes de comenzar')
  return { timezone: zone(v.timezone), expectedVersion: version(v.expectedVersion, true), validFrom, validUntil,
    inheritBranch: v.inheritBranch === undefined ? false : boolean(v.inheritBranch, 'inheritBranch'), weekly, exceptions }
}
function range(v, maxDays) {
  const from = instant(v.from, 'from'), to = instant(v.to, 'to')
  const days = (new Date(to) - new Date(from)) / 86400000
  if (days <= 0 || days > maxDays + 1 / 24) invalid('to', `Selecciona un período de hasta ${maxDays} días`)
  return { from, to }
}
function parseFilter(raw) {
  const v = object(raw, ['from', 'to', 'q', 'providerId', 'resourceId', 'productId', 'status', 'page', 'pageSize'])
  const out = { ...range(v, 42), q: text(v.q, 'q', 150, false), page: integer(v.page ?? 1, 'page', 1, 1000000, true), pageSize: integer(v.pageSize ?? 10, 'pageSize', 1, 100, true) }
  for (const key of ['providerId', 'resourceId', 'productId']) if (v[key] !== undefined && v[key] !== '') out[key] = uuid(v[key], key)
  if (v.status !== undefined && v.status !== '') out.status = choice(v.status, 'status', BOOKING_STATUSES)
  return out
}
function parseAvailability(raw) {
  const v = object(raw, ['productId', 'from', 'to', 'providerIds', 'resourceIds','venue','outboundMinutes','returnMinutes','durationMinutes'])
  return { ...parseLocation(v),...(v.durationMinutes===undefined?{}:{durationMinutes:integer(v.durationMinutes,'durationMinutes',1,1440)}), productId: uuid(v.productId, 'productId'), ...range(v, 31), providerIds: ids(v.providerIds ?? [], 'providerIds'), resourceIds: ids(v.resourceIds ?? [], 'resourceIds') }
}
function optionalEnd(v){return v.endsAt===undefined?{}:{endsAt:instant(v.endsAt,'endsAt')}}
function parseLocation(v) { return {venue:require('./activities').parseVenue(v.venue??{kind:'BRANCH'}),
  outboundMinutes:integer(v.outboundMinutes??0,'outboundMinutes',0,1440),returnMinutes:integer(v.returnMinutes??0,'returnMinutes',0,1440)} }
module.exports = { fail, invalid, object, text, integer, boolean, choice, uuid, ids, zone, instant, localDate, clock, version, requestKey, quantity,
  parseProfile, parseBooking, parseSession, parseEnroll, parseMove, parseTransition, parseCalendar, parseFilter, parseAvailability, BOOKING_STATUSES }
