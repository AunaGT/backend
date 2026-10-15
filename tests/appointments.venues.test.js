const test=require('node:test'),assert=require('node:assert/strict')
test('sala fija y equipo no transportable no salen; capacidad no significa cupos de venta',()=>{
  const {validateVenueAssignments}=require('../src/modules/appointments/domain/activities')
  assert.throws(()=>validateVenueAssignments({kind:'HOME'},[{type:'ROOM',portable:false,person_capacity:5}],80),{status:400})
  assert.throws(()=>validateVenueAssignments({kind:'EVENT_VENUE'},[{type:'EQUIPMENT',portable:false}],80),{status:400})
  assert.throws(()=>validateVenueAssignments({kind:'BRANCH'},[{type:'ROOM',person_capacity:5}],80),{code:'ROOM_CAPACITY'})
  assert.doesNotThrow(()=>validateVenueAssignments({kind:'EVENT_VENUE'},[{type:'EQUIPMENT',portable:true}],80))
})
test('reserva configurada acepta lugar y traslados, pero no montaje impuesto por cliente',()=>{
  const {parseBooking}=require('../src/modules/appointments/domain/validation')
  const id='00000000-0000-4000-8000-000000000001'
  const raw={productId:id,contactId:id,startsAt:'2030-01-01T15:00Z',timezone:'America/Guatemala',providerIds:[],resourceIds:[],quantity:'1',notes:'',idempotencyKey:'venues-test',venue:{kind:'HOME',address:'Casa del cliente'},outboundMinutes:30,returnMinutes:45}
  assert.equal(parseBooking(raw).venue.kind,'HOME');assert.equal(parseBooking(raw).outboundMinutes,30)
  assert.throws(()=>parseBooking({...raw,setupMinutes:1}),{status:400})
  assert.throws(()=>parseBooking({...raw,venue:{kind:'ONLINE',url:'javascript:alert(1)'}}),{status:400})
})
