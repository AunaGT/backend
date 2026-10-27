const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {timelineTestUrl,timelineClient}=require('./helpers/timelineTestDb.cjs')
const target=timelineTestUrl(),generated=timelineClient(target,{namespace:true})
require.cache[require.resolve('@prisma/client')]={exports:generated}
process.env.DATABASE_URL=target;process.env.DIRECT_URL=target
process.env.JWT_SECRET='synthetic-timeline-acceptance-not-a-real-secret-2026'
const {createActivity,updateActivity,transitionActivity}=require('../src/modules/appointments/activities')
const {withAgendaTransaction,createBooking}=require('../src/modules/appointments/application')
const {createEngagement,programEngagement}=require('../src/modules/appointments/engagements')
const {saveServiceProfile}=require('../src/modules/appointments/profiles')
const {saveCalendar}=require('../src/modules/appointments/calendars')
const {readAvailability}=require('../src/modules/appointments/queries')
const {listDirectory,saveProvider}=require('../src/modules/appointments/directory')
test('operational timelines reserve real identities atomically in an isolated PostgreSQL database',async t=>{
 const db=new generated.PrismaClient({datasources:{db:{url:target}}}),other=new generated.PrismaClient({datasources:{db:{url:target}}})
 t.after(async()=>{await Promise.all([db.$disconnect(),other.$disconnect()])})
 const company=await db.company.create({data:{name:'Synthetic timeline acceptance',code:randomUUID().slice(0,12)}})
 const role=await db.role.create({data:{name:'Synthetic '+randomUUID()}}),actors=[]
 const branch=await db.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'TL'}})
 for(let i=0;i<3;i++){
  const actor=await db.user.create({data:{name:'Synthetic actor '+i,email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
  await db.userCompany.create({data:{company_id:company.id,user_id:actor.id}});await db.userBranch.create({data:{branch_id:branch.id,user_id:actor.id}});actors.push(actor)
 }
 await db.companyModule.create({data:{company_id:company.id,module_code:'appointments',status:'ACTIVE'}})
 await db.systemSetting.create({data:{company_id:company.id,key:'inventory_services_enabled',value:'true',type:'boolean'}})
 const scope={companyId:company.id,branchId:branch.id,branchIds:[branch.id],userId:actors[0].id,isAdmin:true,permissions:[]}
 const provider=await db.serviceProvider.create({data:{company_id:company.id,user_id:actors[2].id,name:'Synthetic performer',created_by:scope.userId}})
 await db.serviceProviderBranch.create({data:{company_id:company.id,branch_id:branch.id,provider_id:provider.id}})
 const resource=await db.scheduleResource.create({data:{company_id:company.id,branch_id:branch.id,type:'EQUIPMENT',portable:true,name:'Synthetic sound'}})
 const category=await db.productCategory.create({data:{company_id:company.id,name:'Synthetic services'}}),status=await db.stockStatus.create({data:{name:'Synthetic '+randomUUID()}})
 const contact=await db.supplier.create({data:{company_id:company.id,name:'Synthetic customer',contact:'Synthetic',party_type:'CUSTOMER'}})
 const calendar={timezone:'UTC',expectedVersion:0,weekly:Array.from({length:7},(_,i)=>({weekday:i+1,from:'00:00',to:'24:00'})),exceptions:[]}
 await withAgendaTransaction(db,company.id,async tx=>{
  assert.equal(require('../src/modules/appointments/timelineStorage').timelineStorageReady(tx),true,'temporary transaction client recognizes the new storage')
  await saveCalendar(tx,scope,'branch',branch.id,calendar)
  await saveCalendar(tx,scope,'provider',provider.id,{...calendar,inheritBranch:true,weekly:[]})
  await saveCalendar(tx,scope,'resource',resource.id,{...calendar,inheritBranch:true,weekly:[]})
 })
 const start=require('luxon').DateTime.utc().plus({days:2}).startOf('day').set({hour:18}).toISO()
 const at=(day,minute=0)=>new Date(Date.parse(start)+day*86400000+minute*60000).toISOString()
 const timeline=(offset=60)=>({schemaVersion:1,milestones:[],attendanceWindows:[{kind:'PROVIDER',entityId:provider.id,startOffsetMinutes:offset,endOffsetMinutes:offset+30,outboundMinutes:10,setupMinutes:0,teardownMinutes:0,returnMinutes:10}],requirementWindows:[]})
 const input=(day,organizer=0,offset=60)=>({purpose:'EVENT',title:'Synthetic event',startsAt:at(day),endsAt:at(day,240),timezone:'UTC',organizerId:actors[organizer].id,userIds:[],providerIds:[provider.id],resourceIds:[],guests:[],productId:null,venue:{kind:'EVENT_VENUE',address:'Synthetic venue'},outboundMinutes:0,setupMinutes:0,teardownMinutes:0,returnMinutes:0,notes:'Synthetic private note',idempotencyKey:randomUUID(),operationalTimeline:timeline(offset)})
 await t.test('same intervention competes on two connections; receipt replay has one effect',async()=>{
  const raw=[input(0,0),input(0,1)],results=await Promise.allSettled(raw.map((r,i)=>createActivity(i?other:db,scope,r)))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results.map(r=>r.reason?.message)))
  const winner=results.findIndex(r=>r.status==='fulfilled'),loser=1-winner
  assert.equal(results[loser].reason.code,'SCHEDULE_CONFLICT')
  assert.equal((await createActivity(db,scope,raw[winner])).id,results[winner].value.id)
  assert.equal(await db.appointmentSession.count({where:{company_id:company.id}}),1)
  assert.equal(await db.appointmentRequest.count({where:{company_id:company.id}}),1)
  await transitionActivity(db,scope,results[winner].value.id,{action:'CANCEL',expectedVersion:1,reason:'Synthetic cancellation',idempotencyKey:randomUUID()})
  await assert.doesNotReject(()=>createActivity(db,scope,raw[loser]))
 })
 await t.test('disjoint interventions permit overlapping events, while full-time sound still blocks',async()=>{
  const results=await Promise.all([createActivity(db,scope,input(1,0,60)),createActivity(other,scope,input(1,1,120))])
  assert.equal(results.length,2)
  const first={...input(2,0,60),resourceIds:[resource.id]},second={...input(2,1,120),resourceIds:[resource.id]}
  await createActivity(db,scope,first)
  await assert.rejects(()=>createActivity(other,scope,second),{code:'SCHEDULE_CONFLICT'})
 })
 await t.test('user alias remains busy; moving preserves offsets and shortening rolls back',async()=>{
  const original=input(3),saved=await createActivity(db,scope,original)
  const alias={...input(3,1),providerIds:[],userIds:[actors[2].id],startsAt:at(3,75),endsAt:at(3,105)};delete alias.operationalTimeline
  await assert.rejects(()=>createActivity(other,scope,alias),{code:'SCHEDULE_CONFLICT'})
  const edit={...original,startsAt:at(4),endsAt:at(4,240),expectedVersion:1,reason:'Synthetic move',idempotencyKey:randomUUID()};delete edit.operationalTimeline
  const moved=await updateActivity(db,scope,saved.id,edit)
  assert.deepEqual(moved.operationalTimeline,original.operationalTimeline)
  const reservation=moved.attendanceReservations.find(r=>r.kind==='PROVIDER'&&r.entityId===provider.id)
  assert.equal(reservation.from,at(4,50));assert.equal(reservation.to,at(4,100))
  await assert.rejects(()=>updateActivity(db,scope,saved.id,{...edit,endsAt:at(4,60),expectedVersion:2,idempotencyKey:randomUUID()}),{code:'INVALID_INPUT'})
  assert.equal((await db.appointmentSession.findUnique({where:{id:saved.id}})).version,2)
  assert.equal(await db.appointmentRequest.count({where:{company_id:company.id,idempotency_key:edit.idempotencyKey}}),1)
 })
 await t.test('early completion keeps its own return buffer, and organizer aliases keep the whole range',async()=>{
  const saved=await createActivity(db,scope,input(11))
  await db.appointmentSession.update({where:{id:saved.id},data:{status:'COMPLETED',actual_completed_at:new Date()}})
  const next={...input(11,1),startsAt:at(11,95),endsAt:at(11,110)};delete next.operationalTimeline
  await assert.rejects(()=>createActivity(other,scope,next),{code:'SCHEDULE_CONFLICT'})
  await assert.doesNotReject(()=>createActivity(other,scope,{...next,startsAt:at(11,100),endsAt:at(11,130),idempotencyKey:randomUUID()}))
  const alias=await createActivity(db,scope,input(12,2))
  const reserved=alias.attendanceReservations.find(r=>r.kind==='PROVIDER'&&r.entityId===provider.id)
  assert.equal(reserved.from,at(12));assert.equal(reserved.to,at(12,240))
 })
 const req={id:randomUUID(),kind:'PROVIDER',name:'Bienvenida',quantity:1,optionIds:[provider.id],attendanceMode:'INTERVENTION'}
 const profile={enabled:true,schedulingStyle:'WORK',mode:'INDIVIDUAL',durationPolicy:'EDITABLE',durationMinutes:240,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:false,requiresResource:false,branchIds:[branch.id],providerIds:[provider.id],resourceIds:[],assignmentRequirements:[req],allowedVenueKinds:['EVENT_VENUE'],instructions:'',expectedVersion:0}
 const product=await db.product.create({data:{company_id:company.id,name:'Synthetic work',kind:'SERVICE',service_unit_label:'evento',category_id:category.id,status_id:status.id,price:'25',cost:'0'}})
 await withAgendaTransaction(db,company.id,tx=>saveServiceProfile(tx,scope,product.id,profile))
 const contractedTimeline=()=>({...timeline(),milestones:[{id:req.id,name:'Bienvenida',startOffsetMinutes:60,endOffsetMinutes:90}],requirementWindows:[{requirementId:req.id,milestoneId:req.id}]})
 const engagement=lines=>createEngagement(db,scope,{contactId:contact.id,lines:lines||[{productId:product.id,quantity:'1'}],idempotencyKey:randomUUID()})
 const program=(e,line,day)=>({...input(day),lineId:line.id,quantity:'1',acknowledgedConditionsVersion:line.conditionsVersion,operationalTimeline:contractedTimeline()})
 const cleanProgram=p=>{const {purpose,productId,idempotencyKey,setupMinutes,teardownMinutes,...result}=p;return result}
 await t.test('a second incomplete intervention rolls back the first program, document, history and receipt',async()=>{
  const e=await engagement([{productId:product.id,quantity:'1'},{productId:product.id,quantity:'1'}])
  const programs=e.lines.map((line,i)=>cleanProgram(program(e,line,6+i)))
  programs[1].operationalTimeline.attendanceWindows[0].endOffsetMinutes=75
  const before=await Promise.all([db.appointmentSession.count({where:{company_id:company.id}}),db.sale.count({where:{branch_id:branch.id}})])
  const raw={programs,expectedVersion:e.version,partial:false,idempotencyKey:randomUUID()}
  await assert.rejects(()=>programEngagement(db,scope,e.id,raw),{code:'REQUIREMENTS_INCOMPLETE'})
  assert.deepEqual(await Promise.all([db.appointmentSession.count({where:{company_id:company.id}}),db.sale.count({where:{branch_id:branch.id}})]),before)
  assert.equal(await db.appointmentEngagementSchedule.count({where:{engagement_id:e.id}}),0)
  assert.equal(await db.appointmentEngagementHistory.count({where:{engagement_id:e.id,action:'PROGRAMMED'}}),0)
  assert.equal(await db.appointmentRequest.count({where:{company_id:company.id,idempotency_key:raw.idempotencyKey}}),0)
  programs[1].operationalTimeline.attendanceWindows[0].endOffsetMinutes=90
  const saved=await programEngagement(db,scope,e.id,raw)
  assert.equal(saved.version,e.version+1)
  await programEngagement(other,scope,e.id,raw)
  assert.equal(await db.appointmentEngagementSchedule.count({where:{engagement_id:e.id}}),2)
  const sessions=await db.appointmentSession.findMany({where:{company_id:company.id,engagement_schedules:{some:{engagement_id:e.id}}}})
  assert.ok(sessions.every(s=>s.operational_timeline.requirementWindows[0].requirementId===req.id&&s.policy_snapshot.assignmentRequirements[0].attendanceMode==='INTERVENTION'))
 })
 await t.test('appointment availability and reservation respect precise busy blocks',async()=>{
  const p=await db.product.create({data:{company_id:company.id,name:'Synthetic consultation',kind:'SERVICE',service_unit_label:'sesión',category_id:category.id,status_id:status.id,price:'10',cost:'0'}})
  await withAgendaTransaction(db,company.id,tx=>saveServiceProfile(tx,scope,p.id,{...profile,schedulingStyle:'APPOINTMENT',durationPolicy:'FIXED',durationMinutes:30,allowedVenueKinds:['BRANCH'],assignmentRequirements:[],requiresProvider:true}))
  await createActivity(db,scope,input(8,0,60))
  const slots=await readAvailability(db,scope,{productId:p.id,from:at(8),to:at(8,240),providerIds:[provider.id],resourceIds:[]})
  assert.ok(slots.some(s=>s.startsAt===at(8,120)));assert.ok(!slots.some(s=>s.startsAt===at(8,75)))
  await createBooking(db,scope,{productId:p.id,contactId:contact.id,startsAt:at(8,120),timezone:'UTC',providerIds:[provider.id],resourceIds:[],quantity:'1',notes:'Synthetic',idempotencyKey:randomUUID()})
 })
 await t.test('user-linked absence rejects the intervention; an old runtime stays usable without new storage',async()=>{
  await db.companyModule.create({data:{company_id:company.id,module_code:'hr',status:'ACTIVE'}})
  const employee=await db.employee.create({data:{company_id:company.id,branch_id:branch.id,user_id:actors[2].id,code:'TL',first_name:'Synthetic',last_name:'Performer',hire_date:new Date('2020-01-01'),base_salary:0}})
  await db.attendance.create({data:{company_id:company.id,branch_id:branch.id,employee_id:employee.id,work_date:new Date(at(9).slice(0,10)),status:'AUSENTE'}})
  await assert.rejects(()=>createActivity(other,scope,input(9)),{code:'ABSENCE_CONFLICT'})
  const Legacy=timelineClient(target,{legacy:true}),legacy=new Legacy({datasources:{db:{url:target}}});t.after(()=>legacy.$disconnect())
  assert.equal((await listDirectory(legacy,scope)).operationalTimelineEnabled,false)
  await assert.rejects(()=>createActivity(legacy,scope,input(10)),{code:'TIMELINE_NOT_READY'})
  const raw=input(10);delete raw.operationalTimeline
  await assert.doesNotReject(()=>createActivity(legacy,scope,raw))
 })
 await t.test('legacy identity linking and USER attendance obey the same conflicts and calendars',async()=>{
  const user=await db.user.create({data:{name:'Synthetic newly linked user',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
  await db.userCompany.create({data:{company_id:company.id,user_id:user.id}});await db.userBranch.create({data:{branch_id:branch.id,user_id:user.id}})
  const p=await db.serviceProvider.create({data:{company_id:company.id,name:'Synthetic unlinked professional',created_by:scope.userId}})
  await db.serviceProviderBranch.create({data:{company_id:company.id,branch_id:branch.id,provider_id:p.id}})
  const original={...input(14),providerIds:[p.id]};delete original.operationalTimeline
  await createActivity(db,scope,original)
  await createActivity(other,scope,{...original,providerIds:[],organizerId:user.id,idempotencyKey:randomUUID()})
  await assert.rejects(()=>withAgendaTransaction(db,company.id,tx=>saveProvider(tx,scope,p.id,{name:p.name,userId:user.id,active:true,branchIds:[branch.id],expectedVersion:1})),{code:'IDENTITY_CONFLICT'})
  assert.equal((await db.serviceProvider.findUnique({where:{id:p.id}})).user_id,null)
  await withAgendaTransaction(db,company.id,tx=>saveCalendar(tx,scope,'provider',provider.id,{...calendar,expectedVersion:1,inheritBranch:false,weekly:Array.from({length:7},(_,i)=>({weekday:i+1,from:'19:00',to:'19:30'}))}))
  const custom={...input(15),providerIds:[],userIds:[actors[2].id]}
  custom.operationalTimeline.attendanceWindows=[{...timeline().attendanceWindows[0],kind:'USER',entityId:actors[2].id,outboundMinutes:0,returnMinutes:0}]
  await assert.doesNotReject(()=>createActivity(db,scope,custom))
  const outside=structuredClone(custom);outside.startsAt=at(16);outside.endsAt=at(16,240);outside.idempotencyKey=randomUUID();outside.operationalTimeline.attendanceWindows[0].startOffsetMinutes=45
  await assert.rejects(()=>createActivity(other,scope,outside),{code:'OUTSIDE_CALENDAR'})
  const organizer={...input(17,2),providerIds:[]};delete organizer.operationalTimeline
  await assert.rejects(()=>createActivity(other,scope,organizer),{code:'OUTSIDE_CALENDAR'})
 })
 t.diagnostic('Disposable loopback PostgreSQL, two independent clients. No active database/client, provider endpoint, stock or payment changes.')
})
