const { DateTime } = require('luxon')
const v = require('./validation')
const PURPOSES = ['MEETING', 'SERVICE_VISIT', 'EVENT']
const VENUE_KINDS = ['BRANCH', 'HOME', 'EVENT_VENUE', 'ONLINE']
const keys = ['purpose','title','startsAt','endsAt','timezone','organizerId','userIds','providerIds','resourceIds',
  'guests','productId','venue','estimatedAttendance','outboundMinutes','setupMinutes','teardownMinutes','returnMinutes','notes','idempotencyKey','serviceScheduling','completionPolicy']

function parseVenue(raw) {
  const input = v.object(raw, ['kind','name','address','references','url'])
  const kind = v.choice(input.kind, 'venue.kind', VENUE_KINDS)
  const result = {kind, name:v.text(input.name,'venue.name',200,false),
    address:v.text(input.address,'venue.address',2000,['HOME','EVENT_VENUE'].includes(kind)),
    references:v.text(input.references,'venue.references',2000,false),url:v.text(input.url,'venue.url',2000,false)}
  if (result.url) {
    let parsed
    try { parsed = new URL(result.url) } catch { v.invalid('venue.url','Ingresa un enlace HTTPS válido') }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password)
      v.invalid('venue.url','Ingresa un enlace HTTPS sin credenciales')
  }
  return result
}
function parseFields(input) {
  const startsAt=v.instant(input.startsAt,'startsAt'), endsAt=v.instant(input.endsAt,'endsAt')
  const duration=new Date(endsAt)-new Date(startsAt)
  if (duration<=0 || duration>31*86400000) v.invalid('endsAt','Selecciona un fin posterior al inicio, hasta 31 días')
  if (!Array.isArray(input.guests) || input.guests.length>100) v.invalid('guests','Agrega hasta 100 invitados')
  const contacts=new Set()
  const guests=input.guests.map(raw=>{
    const guest=v.object(raw,['name','contactId'])
    const contactId=guest.contactId==null ? null : v.uuid(guest.contactId,'guests.contactId')
    if (contactId && contacts.has(contactId)) v.invalid('guests','El contacto ya está invitado')
    if (contactId) contacts.add(contactId)
    return {name:v.text(guest.name,'guests.name',150),contactId}
  })
  const result={completionPolicy:v.choice(input.completionPolicy??'MANUAL','completionPolicy',['MANUAL','AUTO']),purpose:v.choice(input.purpose,'purpose',PURPOSES),title:v.text(input.title,'title',200),startsAt,endsAt,
    timezone:v.zone(input.timezone),organizerId:v.uuid(input.organizerId,'organizerId'),
    userIds:v.ids(input.userIds,'userIds'),providerIds:v.ids(input.providerIds,'providerIds'),resourceIds:v.ids(input.resourceIds,'resourceIds'),
    guests,productId:input.productId==null ? null : v.uuid(input.productId,'productId'),venue:parseVenue(input.venue),
    estimatedAttendance:input.estimatedAttendance==null ? null : v.integer(input.estimatedAttendance,'estimatedAttendance',1,1000000),
    notes:v.text(input.notes,'notes',2000,false),idempotencyKey:v.requestKey(input.idempotencyKey)}
  if(input.serviceScheduling!==undefined) result.serviceScheduling=v.choice(input.serviceScheduling,'serviceScheduling',['CONFIGURED'])
  for(const key of ['outboundMinutes','setupMinutes','teardownMinutes','returnMinutes']) result[key]=v.integer(input[key]??0,key,0,1440)
  return result
}
function parseActivity(raw) { return parseFields(v.object(raw,keys)) }
function parseActivityUpdate(raw) {
  const input=v.object(raw,[...keys,'expectedVersion','reason'])
  return {...parseFields(input),expectedVersion:v.version(input.expectedVersion),reason:v.text(input.reason,'reason',500)}
}
function parseActivityTransition(raw) {
  if(raw?.action!=='CONFIRM_COMPLETION')return v.parseTransition(raw,true)
  const input=v.object(raw,['action','expectedVersion','idempotencyKey','reason'])
  return {action:input.action,expectedVersion:v.version(input.expectedVersion),idempotencyKey:v.requestKey(input.idempotencyKey),reason:v.text(input.reason,'reason',500)}
}
function activityInterval(input) {
  return {startsAt:input.startsAt,endsAt:input.endsAt,
    occupiedFrom:DateTime.fromISO(input.startsAt).minus({minutes:input.outboundMinutes+input.setupMinutes}).toUTC().toISO(),
    occupiedUntil:DateTime.fromISO(input.endsAt).plus({minutes:input.teardownMinutes+input.returnMinutes}).toUTC().toISO()}
}
function validateVenueAssignments(venue,resources,estimatedAttendance) {
  for(const resource of resources) {
    if(venue.kind!=='BRANCH'&&(resource.type==='ROOM'||!resource.portable))
      v.fail(400,'RESOURCE_NOT_PORTABLE','Selecciona equipo transportable para atención externa')
    if(resource.type==='ROOM'&&estimatedAttendance!=null&&resource.person_capacity!=null&&estimatedAttendance>resource.person_capacity)
      v.fail(400,'ROOM_CAPACITY','La cantidad de asistentes supera la capacidad de la sala')
  }
}
module.exports={PURPOSES,VENUE_KINDS,parseVenue,parseActivity,parseActivityUpdate,parseActivityTransition,activityInterval,validateVenueAssignments}
