const test = require('node:test'), assert = require('node:assert/strict')
const { activityInput } = require('./helpers/agendaActivityFixture.cjs')
const id = '00000000-0000-4000-8000-000000000001'
function domain() { return require('../src/modules/appointments/domain/activities') }

test('show reserva montaje y traslado sin catálogo ni cupos comerciales', () => {
  const { parseActivity, activityInterval } = domain()
  const input = parseActivity(activityInput({userId:id}, {
    purpose:'EVENT', startsAt:'2030-01-01T18:00:00-06:00', endsAt:'2030-01-01T20:00:00-06:00',
    outboundMinutes:30, setupMinutes:60, teardownMinutes:30, returnMinutes:30, estimatedAttendance:80,
  }))
  assert.deepEqual(activityInterval(input), {startsAt:'2030-01-02T00:00:00.000Z',endsAt:'2030-01-02T02:00:00.000Z',
    occupiedFrom:'2030-01-01T22:30:00.000Z',occupiedUntil:'2030-01-02T03:00:00.000Z'})
  assert.equal(input.productId,null)
  assert.deepEqual(input.guests,[])
  assert.equal(input.estimatedAttendance,80)
})
test('actividad rechaza tenant, dinero, cupos, estado y entradas fuera de límites', () => {
  const {parseActivity} = domain(), input = activityInput({userId:id})
  for (const patch of [{companyId:id},{branchId:id},{paid:true},{price:'10'},{capacity:80},{status:'COMPLETED'},
    {title:''},{title:'a'.repeat(201)},{notes:'a'.repeat(2001)},{purpose:'CLASS'},{organizerId:'foreign'},
    {startsAt:'2030-01-01T15:00'},{timezone:'Bad/Zone'},{endsAt:input.startsAt},
    {endsAt:'2030-02-02T15:00:00Z'},{outboundMinutes:-1},{setupMinutes:1441},{returnMinutes:0.5},
    {estimatedAttendance:0},{estimatedAttendance:1000001},{userIds:Array(101).fill(id)},
    {guests:Array(101).fill({name:'Invitado',contactId:null})},{guests:[{name:'',contactId:null}]},
    {guests:[{name:'a'.repeat(151),contactId:null}]},{guests:[{name:'QA',contactId:null,paid:true}]},
    {venue:{...input.venue,kind:'HOME'}},{venue:{...input.venue,kind:'EVENT_VENUE'}},
    {venue:{...input.venue,kind:'ONLINE',url:'javascript:alert(1)'}},
    {venue:{...input.venue,kind:'ONLINE',url:'http://example.invalid'}},
    {venue:{...input.venue,kind:'ONLINE',url:'https://user:password@example.invalid'}},
    {venue:{...input.venue,address:'a'.repeat(2001)}}, {productId:'not-an-id'}]) {
    assert.throws(() => parseActivity({...input,...patch}), {status:400}, JSON.stringify(patch).slice(0,100))
  }
})
test('actividad normaliza textos, IDs y URL sin modificar la entrada', () => {
  const {parseActivity} = domain(), raw=activityInput({userId:id},{title:'  Visita  ',userIds:[id,id],
    venue:{kind:'HOME',name:' Casa ',address:' Zona 1 ',references:' Portón ',url:''},
    guests:[{name:' Invitado ',contactId:null}]})
  const result=parseActivity(raw)
  assert.equal(result.title,'Visita'); assert.equal(raw.title,'  Visita  ')
  assert.deepEqual(result.userIds,[id]); assert.equal(result.venue.address,'Zona 1')
  assert.deepEqual(result.guests,[{name:'Invitado',contactId:null}])
  assert.equal(parseActivity({...raw,venue:{...raw.venue,kind:'ONLINE',url:'https://example.invalid/reunion'}}).venue.url,'https://example.invalid/reunion')
})
test('actividad permite medianoche y 31 días, edición exige versión y motivo', () => {
  const {parseActivity,parseActivityUpdate,parseActivityTransition}=domain()
  const input=activityInput({userId:id},{startsAt:'2030-01-01T23:00:00-06:00',endsAt:'2030-02-01T23:00:00-06:00'})
  assert.equal(parseActivity(input).endsAt,'2030-02-02T05:00:00.000Z')
  assert.equal(parseActivityUpdate({...input,expectedVersion:2,reason:' Cambio de lugar '}).reason,'Cambio de lugar')
  for(const patch of [{expectedVersion:0,reason:'QA'},{expectedVersion:1,reason:''}])
    assert.throws(()=>parseActivityUpdate({...input,...patch}),{status:400})
  const transition={action:'CANCEL',expectedVersion:1,reason:'Cliente cancela',idempotencyKey:input.idempotencyKey}
  assert.equal(parseActivityTransition(transition).action,'CANCEL')
  assert.throws(()=>parseActivityTransition({...transition,reason:''}),{status:400})
  assert.throws(()=>parseActivityTransition({...transition,action:'PAID'}),{status:400})
})
