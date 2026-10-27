require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {parseActivity,parseActivityUpdate}=require('../src/modules/appointments/domain/activities')
const {applyConfiguredActivityPolicy}=require('../src/modules/appointments/configuredActivities')
const {parsePrograms}=require('../src/modules/appointments/engagementScheduling')
const {createEngagementSchedule}=require('../src/modules/appointments/engagementScheduling')
const {createActivity,updateActivity}=require('../src/modules/appointments/activities')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={companyId:id(1),branchId:id(2),branchIds:[id(2)],userId:id(3),isAdmin:true,permissions:[]}
const timeline=()=>({schemaVersion:1,milestones:[{id:id(10),name:'Bienvenida',startOffsetMinutes:60,endOffsetMinutes:90}],attendanceWindows:[{kind:'PROVIDER',entityId:id(4),startOffsetMinutes:60,endOffsetMinutes:90,outboundMinutes:10,setupMinutes:5,teardownMinutes:5,returnMinutes:10}],requirementWindows:[]})
const input=()=>({purpose:'EVENT',title:'Evento',startsAt:'2030-01-01T18:00:00Z',endsAt:'2030-01-01T22:00:00Z',timezone:'UTC',organizerId:id(3),userIds:[],providerIds:[id(4)],resourceIds:[],guests:[],productId:null,venue:{kind:'EVENT_VENUE',address:'Lugar del evento'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0,idempotencyKey:'timeline-test'})
const requirement=(mode='FULL')=>({id:id(20),kind:'PROVIDER',name:'Atención',quantity:1,optionIds:[id(4)],attendanceMode:mode})
const oldPolicy=(requirements=[])=>({product_id:id(9),policy_snapshot:{serviceScheduling:'CONFIGURED',schedulingStyle:'WORK',durationPolicy:'EDITABLE',durationMinutes:240,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,completionPolicy:'MANUAL',allowedVenueKinds:['EVENT_VENUE'],requiresProvider:true,requiresResource:false,providerIds:[id(4)],resourceIds:[],assignmentRequirements:requirements}})
const db={serviceProvider:{findMany:async()=>[{id:id(4),user_id:null,employee_id:null}]}}
test('activity and engagement parsers carry optional timelines without turning omission into deletion',()=>{
 const t=timeline();assert.deepEqual(parseActivity({...input(),operationalTimeline:t}).operationalTimeline,t)
 assert.ok(!Object.hasOwn(parseActivityUpdate({...input(),expectedVersion:1,reason:'Cambio'}),'operationalTimeline'))
 const programs=parsePrograms({expectedVersion:1,idempotencyKey:'timeline-program',partial:false,programs:[{lineId:id(30),quantity:'1',startsAt:input().startsAt,endsAt:input().endsAt,timezone:'UTC',acknowledgedConditionsVersion:'a'.repeat(64),operationalTimeline:t}]})
 assert.deepEqual(programs.programs[0].operationalTimeline,t)
})
test('old editor omission preserves the saved offsets, moving preserves them, shortening never clips',async()=>{
 const old={operational_timeline:timeline()}
 const out=await applyConfiguredActivityPolicy(db,scope,parseActivity(input()),old)
 assert.deepEqual(out.input.operationalTimeline,timeline())
 const moved=await applyConfiguredActivityPolicy(db,scope,parseActivity({...input(),startsAt:'2030-01-02T18:00:00Z',endsAt:'2030-01-02T22:00:00Z'}),old)
 assert.deepEqual(moved.input.operationalTimeline,timeline())
 await assert.rejects(()=>applyConfiguredActivityPolicy(db,scope,parseActivity({...input(),endsAt:'2030-01-01T19:00:00Z'}),old),{code:'INVALID_INPUT'})
})
test('a short provider cannot fill FULL or the legacy full-time requirement',async()=>{
 for(const requirements of [[requirement()],[]])await assert.rejects(()=>applyConfiguredActivityPolicy(db,scope,{...parseActivity({...input(),productId:id(9),serviceScheduling:'CONFIGURED'}),operationalTimeline:timeline()},oldPolicy(requirements)),{code:'REQUIREMENTS_INCOMPLETE'})
})
test('intervention covers its complete milestone and explicit clearing revalidates its obligation',async()=>{
 const t=timeline();t.requirementWindows=[{requirementId:id(20),milestoneId:id(10)}]
 const raw={...input(),productId:id(9),serviceScheduling:'CONFIGURED',operationalTimeline:t},old={...oldPolicy([requirement('INTERVENTION')]),operational_timeline:t}
 assert.deepEqual((await applyConfiguredActivityPolicy(db,scope,parseActivity(raw),old)).input.operationalTimeline,t)
 const incomplete=structuredClone(raw);incomplete.operationalTimeline.attendanceWindows[0].endOffsetMinutes=75
 await assert.rejects(()=>applyConfiguredActivityPolicy(db,scope,parseActivity(incomplete),old),{code:'REQUIREMENTS_INCOMPLETE'})
 await assert.rejects(()=>applyConfiguredActivityPolicy(db,scope,parseActivity({...raw,operationalTimeline:{schemaVersion:1,milestones:[],attendanceWindows:[],requirementWindows:[]}}),old),{code:'INVALID_INPUT'})
})
test('nonempty timelines require deployed storage but the previous activity editor remains usable',async()=>{
 const legacy={...db,_runtimeDataModel:{models:{AppointmentSession:{fields:[{name:'id'}]}}}}
 await assert.rejects(()=>applyConfiguredActivityPolicy(legacy,scope,parseActivity({...input(),operationalTimeline:timeline()})),{code:'TIMELINE_NOT_READY'})
 await assert.doesNotReject(()=>applyConfiguredActivityPolicy(legacy,scope,parseActivity(input())))
})
test('free activities cannot bind nonexistent service requirements',async()=>{
 const t=timeline();t.requirementWindows=[{requirementId:id(20),milestoneId:id(10)}]
 await assert.rejects(()=>applyConfiguredActivityPolicy(db,scope,parseActivity({...input(),operationalTimeline:t})),{code:'INVALID_INPUT'})
})
test('engagement appointments and classes reject an activity timeline instead of silently dropping it',async()=>{
 for(const scheduling_style of ['CLASS','APPOINTMENT']){
  const profile={enabled:true,scheduling_style,duration_policy:'EDITABLE',duration_minutes:240,allowed_venue_kinds:['BRANCH'],branches:[{branch_id:scope.branchId}],assignment_requirements:[]}
  const product={kind:'SERVICE',available_for_sale:true,service_schedule_profile:profile}
  const line={id:id(30),item_kind:'SERVICE',qty:'1',quantity_decimals:0,product_id:id(9),service_schedule_snapshot:null}
  const conditions=require('../src/modules/appointments/commercialQueries').conditionInfo(profile,product,scope.branchId,null)
  const tx={appointmentEngagementSchedule:{findMany:async()=>[]},product:{findFirst:async()=>product}}
  await assert.rejects(()=>createEngagementSchedule(tx,scope,{id:id(40)},line,{quantity:'1',operationalTimeline:timeline(),acknowledgedConditionsVersion:conditions.conditionsVersion},new Date()),{code:'INVALID_INPUT',fields:{operationalTimeline:'Los momentos y horarios propios solo están disponibles para trabajos o eventos'}})
 }
})
function activityDb(){
 let row,history=[],receipt
 const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'}]},systemSetting:{findUnique:async()=>({value:'true'})},
  $executeRaw:async()=>{},$transaction:async work=>work(db),userCompany:{findMany:async()=>[{user_id:id(3)}]},
  serviceProvider:{findMany:async()=>[{id:id(4),user_id:null,employee_id:null}]},scheduleResource:{findMany:async()=>[]},branch:{findFirst:async()=>({id:id(2)})},employee:{findMany:async()=>[]},scheduleCalendar:{findMany:async()=>[]},
  appointmentRequest:{findUnique:async()=>receipt,create:async({data})=>{receipt=data}},
  appointmentSession:{findMany:async()=>[],findFirst:async()=>({...row,providers:[{provider_id:id(4)}],resources:[],participants:[],history,engagement_schedules:[]}),
   create:async({data})=>{row={id:id(50),status:'SCHEDULED',version:1,...data};return row},update:async({data})=>{row={...row,...data,version:row.version+1};return row}},
  appointmentParticipant:{createMany:async()=>{},deleteMany:async()=>{}},appointmentSessionProvider:{createMany:async()=>{},deleteMany:async()=>{}},appointmentSessionResource:{createMany:async()=>{},deleteMany:async()=>{}},
  appointmentHistory:{create:async({data})=>{history.push({...data,id:id(60),created_at:new Date()})}}}
 return {db,row:()=>row,resetReceipt:()=>{receipt=undefined}}
}
test('activity command writes timeline, reads it and replays once without losing its envelope',async()=>{
 const f=activityDb(),t=timeline();t.attendanceWindows[0].returnMinutes=300
 const raw={...input(),operationalTimeline:t},saved=await createActivity(f.db,scope,raw)
 assert.deepEqual(f.row().operational_timeline,t);assert.deepEqual(saved.operationalTimeline,t)
 assert.equal(saved.occupiedUntil,'2030-01-02T00:35:00.000Z')
 assert.equal((await createActivity(f.db,scope,raw)).id,saved.id);assert.equal(f.row().version,1)
 f.resetReceipt()
 await assert.rejects(()=>updateActivity(f.db,scope,saved.id,{...input(),expectedVersion:2,reason:'Cambio',idempotencyKey:'timeline-update'}),{code:'STALE_VERSION'})
 const updated=await updateActivity(f.db,scope,saved.id,{...input(),expectedVersion:1,reason:'Cambio',idempotencyKey:'timeline-update'})
 assert.deepEqual(updated.operationalTimeline,t);assert.equal(updated.version,2)
 assert.ok(!JSON.stringify(updated.history).includes('Lugar del evento'))
})
