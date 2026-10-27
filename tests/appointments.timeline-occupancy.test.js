require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {loadBusyAssignments,assertActivityAvailability}=require('../src/modules/appointments/occupancy')
const {computeSlots}=require('../src/modules/appointments/domain/availability')
const {addConflicts}=require('../src/modules/appointments/queries')
const {saveProvider}=require('../src/modules/appointments/directory')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const date=time=>new Date('2026-11-01T'+time+':00Z')
const timeline={schemaVersion:1,milestones:[],requirementWindows:[],attendanceWindows:[{kind:'PROVIDER',entityId:id(2),startOffsetMinutes:60,endOffsetMinutes:90,outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0}]}
const row=()=>({id:id(10),branch_id:id(100),record_type:'ACTIVITY',status:'SCHEDULED',mode:'INDIVIDUAL',capacity:1,organizer_id:id(1),starts_at:date('18:00'),ends_at:date('22:00'),occupied_from:date('18:00'),occupied_until:date('22:00'),timezone:'UTC',venue:{kind:'EVENT_VENUE'},policy_snapshot:{},operational_timeline:structuredClone(timeline),providers:[{provider_id:id(2)}],resources:[{resource_id:id(3)}],participants:[],bookings:[]})
const scope={companyId:id(99),branchId:id(100),branchIds:[id(100)],userId:id(5),isAdmin:true,permissions:[]}
const provider={id:id(2),user_id:id(6),employee_id:null,active:true,branches:[{branch_id:id(100)}]}
const calendar=(extra={})=>({id:id(30),owner_type:'branch',branch_id:id(100),timezone:'UTC',rules:[{weekday:7,from_minute:0,to_minute:1440}],exceptions:[],...extra})
function dbFor(s){return{companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'}]},systemSetting:{findUnique:async()=>({value:'true'})},employee:{findMany:async()=>[]},attendance:{findMany:async()=>[]},userCompany:{findMany:async()=>[{user_id:id(5)}]},serviceProvider:{findMany:async()=>[provider]},scheduleResource:{findMany:async()=>[]},branch:{findFirst:async()=>({id:id(100)})},appointmentSession:{findMany:async()=>[s]},scheduleCalendar:{findMany:async()=>[calendar(),calendar({owner_type:'provider',branch_id:null,provider_id:id(2)})]}}}
test('busy projection keeps a short professional interval and never expands an alias to the whole event',async()=>{
 const s=row(),identities={providerIds:[id(2),id(4)],userIds:[id(6)],links:[provider,{...provider,id:id(4)}]}
 const blocks=await loadBusyAssignments(dbFor(s),scope,{from:date('18:00'),to:date('22:00'),identities,resourceIds:[id(3)]})
 const p=blocks.find(b=>b.providerIds.includes(id(2)))
 assert.equal(p.start,+date('19:00'));assert.equal(p.end,+date('19:30'));assert.ok(p.providerIds.includes(id(4)));assert.ok(p.userIds.includes(id(6)))
 assert.equal(blocks.find(b=>b.resourceIds.includes(id(3))).end,+date('22:00'))
})
test('appointment slots and their direct session fallback leave the professional free after the intervention',()=>{
 const s=row(),f={profile:{enabled:true,mode:'INDIVIDUAL',durationMinutes:30,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,requiresProvider:true,requiresResource:false,capacity:1,providerIds:[id(2)],resourceIds:[]},calendars:[calendar(),calendar({owner_type:'provider',branch_id:null,provider_id:id(2)})],providers:[provider],resources:[],sessions:[s],bookings:[],absenceDates:[],from:date('20:00').toISOString(),to:date('20:01').toISOString(),exactStart:date('20:00').toISOString(),now:date('12:00'),timezone:'UTC',branchId:id(100)}
 assert.equal(computeSlots(f).length,1)
 assert.equal(computeSlots({...f,from:date('19:15').toISOString(),to:date('19:16').toISOString(),exactStart:date('19:15').toISOString()}).length,0)
 const blocks=[{start:+date('19:00'),end:+date('19:30'),sessionId:s.id,providerIds:[id(2)],resourceIds:[],session:s}]
 assert.equal(computeSlots({...f,busyAssignments:blocks}).length,1,'raw session fallback must not re-add a full envelope')
})
test('activity availability compares shared identity blocks, not unrelated full-time people or equipment',async()=>{
 const input={startsAt:date('20:00').toISOString(),endsAt:date('20:30').toISOString(),timezone:'UTC',organizerId:id(5),userIds:[],providerIds:[id(2)],resourceIds:[],venue:{kind:'EVENT_VENUE'},outboundMinutes:0,returnMinutes:0,setupMinutes:0,teardownMinutes:0}
 await assert.doesNotReject(()=>assertActivityAvailability(dbFor(row()),scope,input))
 await assert.rejects(()=>assertActivityAvailability(dbFor(row()),scope,{...input,startsAt:date('19:15').toISOString(),endsAt:date('19:45').toISOString()}),{code:'SCHEDULE_CONFLICT'})
})
test('current calendar warnings inspect the professionals own presence rather than the event envelope',async()=>{
 const s=row();s.resources=[]
 const db=dbFor(s);db.scheduleCalendar.findMany=async()=>[calendar(),calendar({owner_type:'provider',branch_id:null,provider_id:id(2),rules:[{weekday:7,from_minute:1140,to_minute:1170}]})]
 const [out]=await addConflicts(db,scope,[s])
 assert.ok(!out.conflicts.includes('Fuera del horario configurado actualmente'))
})
test('an organizer absence is still checked when another professional is assigned',async()=>{
 const db=dbFor(row());db.appointmentSession.findMany=async()=>[]
 db.employee.findMany=async()=>[{id:id(40),user_id:id(5)}]
 db.attendance.findMany=async()=>[{employee_id:id(40),work_date:date('00:00')}]
 const input={startsAt:date('20:00').toISOString(),endsAt:date('20:30').toISOString(),timezone:'UTC',organizerId:id(5),userIds:[],providerIds:[id(2)],resourceIds:[],venue:{kind:'EVENT_VENUE'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0}
 await assert.rejects(()=>assertActivityAvailability(db,scope,input),{code:'ABSENCE_CONFLICT'})
})
test('a late-day absence does not block a person who left the event the previous day',async()=>{
 const db=dbFor(row());db.appointmentSession.findMany=async()=>[]
 db.scheduleCalendar.findMany=async()=>[]
 db.userCompany.findMany=async()=>[{user_id:id(5)},{user_id:id(7)}]
 db.employee.findMany=async()=>[{id:id(40),user_id:id(7)}]
 db.attendance.findMany=async()=>[{employee_id:id(40),work_date:new Date('2026-11-02T00:00:00Z')}]
 const own={kind:'USER',entityId:id(7),startOffsetMinutes:0,endOffsetMinutes:30,outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0}
 const input={startsAt:date('23:00').toISOString(),endsAt:'2026-11-02T02:00:00Z',timezone:'UTC',organizerId:id(5),userIds:[id(7)],providerIds:[id(2)],resourceIds:[],venue:{kind:'EVENT_VENUE'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0,operationalTimeline:{...timeline,attendanceWindows:[own]}}
 await assert.doesNotReject(()=>assertActivityAvailability(db,scope,input))
})
test('linking a professional compares only that persons blocks and still rejects a real overlap',async()=>{
 const s=row(),db=dbFor(s),old={...provider,user_id:null,version:1}
 db.branch.findMany=async()=>[{id:scope.branchId}]
 db.serviceProvider.findFirst=async({where})=>where.id===provider.id?old:null
 db.serviceProvider.findMany=async()=>[]
 db.userCompany.findFirst=async()=>({user_id:id(6)})
 db.serviceProvider.updateMany=async()=>({count:1})
 db.serviceProviderBranch={deleteMany:async()=>{},createMany:async()=>{}}
 let other={...row(),id:id(11),organizer_id:id(6),providers:[],resources:[],starts_at:date('20:00'),ends_at:date('20:30'),occupied_from:date('20:00'),occupied_until:date('20:30'),operational_timeline:undefined}
 db.appointmentSession.findMany=async({where})=>where.providers?[s]:[other]
 const input={name:'Profesional',userId:id(6),branchIds:[scope.branchId],active:true,expectedVersion:1}
 await assert.doesNotReject(()=>saveProvider(db,scope,provider.id,input))
 other={...other,starts_at:date('19:15'),ends_at:date('19:45'),occupied_from:date('19:15'),occupied_until:date('19:45')}
 await assert.rejects(()=>saveProvider(db,scope,provider.id,input),{code:'IDENTITY_CONFLICT'})
})
test('linking legacy activities and service reservations retains their full canonical user occupancy',async()=>{
 for(const record_type of ['ACTIVITY','SCHEDULED_SERVICE']){
  const s={...row(),record_type,operational_timeline:undefined,bookings:[{session_id:id(10),status:'CONFIRMED'}]},db=dbFor(s)
  db.branch.findMany=async()=>[{id:scope.branchId}]
  db.serviceProvider.findFirst=async({where})=>where.id===provider.id?{...provider,user_id:null,version:1}:null
  db.serviceProvider.findMany=async()=>[];db.userCompany.findFirst=async()=>({user_id:id(6)})
  db.serviceProvider.updateMany=async()=>({count:1});db.serviceProviderBranch={deleteMany:async()=>{},createMany:async()=>{}}
  const other={...row(),id:id(11),organizer_id:id(6),providers:[],resources:[],operational_timeline:undefined,occupied_from:date('19:00'),occupied_until:date('20:00')}
  db.appointmentSession.findMany=async({where})=>where.providers?[s]:[other]
  await assert.rejects(()=>saveProvider(db,scope,provider.id,{name:'Profesional',userId:id(6),branchIds:[scope.branchId],active:true,expectedVersion:1}),{code:'IDENTITY_CONFLICT'},record_type)
 }
})
test('a USER organizer or participant cannot bypass a linked professionals closed calendar',async()=>{
 for(const organizer of [true,false]){
  const db=dbFor(row());db.appointmentSession.findMany=async()=>[];db.userCompany.findMany=async()=>[{user_id:id(5)},{user_id:id(6)}]
  db.scheduleCalendar.findMany=async()=>[calendar(),calendar({owner_type:'provider',branch_id:null,provider_id:id(2),rules:[]})]
  const input={startsAt:date('18:00').toISOString(),endsAt:date('22:00').toISOString(),timezone:'UTC',organizerId:organizer?id(6):id(5),userIds:organizer?[]:[id(6)],providerIds:[],resourceIds:[],venue:{kind:'EVENT_VENUE'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0}
  await assert.rejects(()=>assertActivityAvailability(db,scope,input),{code:'OUTSIDE_CALENDAR'})
 }
})
test('a linked USERs own attendance must fit its calendar without requiring unrelated event hours',async()=>{
 const db=dbFor(row());db.appointmentSession.findMany=async()=>[];db.userCompany.findMany=async()=>[{user_id:id(5)},{user_id:id(6)}]
 db.scheduleCalendar.findMany=async()=>[calendar(),calendar({owner_type:'provider',branch_id:null,provider_id:id(2),rules:[{weekday:7,from_minute:1140,to_minute:1170}]})]
 const t={...timeline,attendanceWindows:[{...timeline.attendanceWindows[0],kind:'USER',entityId:id(6)}]},input={startsAt:date('18:00').toISOString(),endsAt:date('22:00').toISOString(),timezone:'UTC',organizerId:id(5),userIds:[id(6)],providerIds:[],resourceIds:[],venue:{kind:'EVENT_VENUE'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0,operationalTimeline:t}
 await assert.doesNotReject(()=>assertActivityAvailability(db,scope,input))
 t.attendanceWindows[0].startOffsetMinutes=45
 await assert.rejects(()=>assertActivityAvailability(db,scope,input),{code:'OUTSIDE_CALENDAR'})
})
