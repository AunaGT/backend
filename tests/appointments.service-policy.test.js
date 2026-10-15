require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {parseProfile}=require('../src/modules/appointments/domain/validation')
const base={enabled:true,mode:'INDIVIDUAL',durationMinutes:45,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,
  leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:false,
  requiresResource:false,branchIds:[],providerIds:[],resourceIds:[],instructions:''}
test('perfil antiguo GROUP sigue clase de duración fija',()=>{
  const p=parseProfile({...base,mode:'GROUP',capacity:8,requiresProvider:true})
  assert.equal(p.schedulingStyle,'CLASS');assert.equal(p.durationPolicy,'FIXED')
})
test('WORK permite duración sugerida multiday sin cupos de inscripción',()=>{
  const p=parseProfile({...base,schedulingStyle:'WORK',durationPolicy:'EDITABLE',durationMinutes:2880})
  assert.equal(p.durationMinutes,2880);assert.equal(p.schedulingStyle,'WORK')
  assert.throws(()=>parseProfile({...base,schedulingStyle:'CLASS'}))
  assert.throws(()=>parseProfile({...base,schedulingStyle:'WORK',capacity:20}))
  assert.throws(()=>parseProfile({...base,durationMinutes:1441}))
})
test('duración editable respeta el fin real; fija rechaza discordancia',()=>{
  const {resolveServiceInterval}=require('../src/modules/appointments/domain/servicePolicy')
  assert.equal(typeof resolveServiceInterval,'function')
  const p={...base,durationPolicy:'EDITABLE'}
  assert.deepEqual(resolveServiceInterval(p,{startsAt:'2030-01-01T15:00Z',endsAt:'2030-01-01T16:30Z'}),
    {startsAt:'2030-01-01T15:00:00.000Z',endsAt:'2030-01-01T16:30:00.000Z',durationMinutes:90})
  assert.throws(()=>resolveServiceInterval({...p,durationPolicy:'FIXED'},{startsAt:'2030-01-01T15:00Z',endsAt:'2030-01-01T16:30Z'}),e=>!!e.fields?.endsAt)
  assert.throws(()=>resolveServiceInterval(p,{startsAt:'2030-01-01T15:00Z',endsAt:'2030-01-01T15:00Z'}))
})
test('cambio horario se calcula con instantes y no resta de hora local',()=>{
  const {resolveServiceInterval}=require('../src/modules/appointments/domain/servicePolicy')
  assert.equal(typeof resolveServiceInterval,'function')
  const range=resolveServiceInterval({...base,durationPolicy:'EDITABLE'},
    {startsAt:'2030-11-03T01:30:00-04:00',endsAt:'2030-11-03T01:30:00-05:00'})
  assert.equal(range.durationMinutes,60)
})
test('asignación opcional no es servicio sin disponibilidad de equipo',()=>{
  const {isManualService}=require('../src/modules/appointments/domain/servicePolicy')
  assert.equal(typeof isManualService,'function')
  assert.equal(isManualService(base,{providerIds:[],resourceIds:[]}),true)
  assert.equal(isManualService(base,{providerIds:['p'],resourceIds:[]}),false)
})
