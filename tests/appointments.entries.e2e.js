const test=require('node:test'),assert=require('node:assert/strict')
const {withAppointmentsTestDb,seedAgenda}=require('./helpers/appointmentsTestDb.cjs')
const {activityInput}=require('./helpers/agendaActivityFixture.cjs')
test('calendario y estadísticas cuentan bloques, no inscripciones, y no revelan invitados',async()=>withAppointmentsTestDb(async context=>{
  await seedAgenda(context)
  const {db,scope,fixtures:f}=context
  const {createActivity}=require('../src/modules/appointments/activities'),{listEntries,readEntriesSummary}=require('../src/modules/appointments/entries')
  const row=await createActivity(db,scope,activityInput(f,{notes:'PRIVADO',guests:[{name:'INVITADA PRIVADA',contactId:null}]}))
  const filter={from:row.startsAt,to:new Date(new Date(row.startsAt).getTime()+3*86400000).toISOString()}
  const list=await listEntries(db,scope,filter),summary=await readEntriesSummary(db,scope,filter)
  assert.equal(list.totalItems,2);assert.equal(summary.activities,2);assert.equal(summary.scheduled,2)
  assert.equal(list.items.find(r=>r.id===row.id).title,'Reunión QA')
  assert.doesNotMatch(JSON.stringify(list),/PRIVADO|INVITADA PRIVADA|unitPrice|"notes"|"guests"/)
  const only={...filter,recordType:'ACTIVITY',q:'Reunión'}
  assert.equal((await listEntries(db,scope,only)).totalItems,1)
  assert.equal((await readEntriesSummary(db,scope,only)).activities,1)
}))
test('período incluye traslado y montaje aunque el trabajo comience al día siguiente',async()=>withAppointmentsTestDb(async({db,scope,fixtures:f})=>{
  const {createActivity}=require('../src/modules/appointments/activities'),{listEntries,readEntriesSummary}=require('../src/modules/appointments/entries')
  await createActivity(db,scope,activityInput(f,{startsAt:'2030-01-02T06:30:00Z',endsAt:'2030-01-02T07:30:00Z',setupMinutes:90}))
  const filter={from:'2030-01-01T06:00:00Z',to:'2030-01-02T06:00:00Z'}
  assert.equal((await listEntries(db,scope,filter)).totalItems,1)
  assert.equal((await readEntriesSummary(db,scope,filter)).activities,1)
}))
