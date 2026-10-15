require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {parseProfile}=require('../src/modules/appointments/domain/validation')
const {activityInput}=require('./helpers/agendaActivityFixture.cjs')
test('completion defaults to MANUAL and AUTO is rejected for appointments and classes',()=>{
  const base={enabled:true,mode:'INDIVIDUAL',durationMinutes:45,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:false,requiresResource:false,branchIds:[],providerIds:[],resourceIds:[],instructions:''}
  assert.equal(parseProfile(base).completionPolicy,'MANUAL')
  assert.equal(parseProfile({...base,schedulingStyle:'WORK',completionPolicy:'AUTO'}).completionPolicy,'AUTO')
  assert.throws(()=>parseProfile({...base,completionPolicy:'AUTO'}),e=>!!e.fields?.completionPolicy)
  assert.throws(()=>parseProfile({...base,mode:'GROUP',schedulingStyle:'CLASS',completionPolicy:'AUTO'}),e=>!!e.fields?.completionPolicy)
})
test('activity closure policy is validated and passed through without accepting paid or completed flags',()=>{
  const {parseActivity}=require('../src/modules/appointments/domain/activities')
  const input=activityInput({userId:'11111111-1111-4111-8111-111111111111'})
  assert.equal(parseActivity(input).completionPolicy,'MANUAL')
  assert.equal(parseActivity({...input,completionPolicy:'AUTO'}).completionPolicy,'AUTO')
  assert.throws(()=>parseActivity({...input,completionPolicy:'paid'}))
  assert.throws(()=>parseActivity({...input,commercialCompletionConfirmedAt:new Date().toISOString()}))
})
test('overdue is calculated from actual instants without a job or an invented completed state',()=>{
  const {completionInfo}=require('../src/modules/appointments/domain/servicePolicy')
  assert.equal(typeof completionInfo,'function')
  const row={status:'SCHEDULED',ends_at:new Date('2030-11-03T01:30:00-04:00'),completion_policy:'AUTO'}
  assert.equal(completionInfo(row,new Date('2030-11-03T01:15:00-05:00')).overdue,true)
  assert.equal(completionInfo({...row,status:'COMPLETED'},new Date('2030-11-03T01:15:00-05:00')).overdue,false)
  assert.equal(row.status,'SCHEDULED')
})
test('worker scans at most 100 candidates and the scheduler starts one nonoverlapping cycle',async t=>{
  const {withMocks}=require('./helpers/reportHarness.cjs'),{closeDueActivities}=require('../src/modules/appointments/autoClose')
  let queries=0,resolve
  const db={companyModule:{findMany:async()=>[{company_id:'qa',company:{company_modules:[{module_code:'appointments',status:'ACTIVE'}]}}]},appointmentSession:{findMany:async args=>{queries++;assert.equal(args.take,100);return new Promise(r=>{resolve=r})}}}
  const tick=()=>new Promise(r=>setImmediate(r))
  const direct=closeDueActivities(db,{limit:500});await tick();resolve([]);assert.equal((await direct).processed,0)
  await withMocks({[require.resolve('../src/models/prisma')]:{prismaTransaction:db}},require.resolve('../src/jobs/appointmentAutoClose'),async job=>{
    t.mock.timers.enable({apis:['setInterval']})
    job.startAppointmentAutoClose();job.startAppointmentAutoClose();await tick();assert.equal(queries,2)
    t.mock.timers.tick(120000);assert.equal(queries,2)
    resolve([]);await new Promise(r=>setImmediate(r))
    t.mock.timers.tick(60000);await tick();assert.equal(queries,3)
    job.stopAppointmentAutoClose();resolve([]);await new Promise(r=>setImmediate(r));t.mock.timers.tick(120000);assert.equal(queries,3)
  })
})
