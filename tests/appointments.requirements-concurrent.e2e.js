const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {requirementsTestUrl,requirementsClient}=require('./helpers/requirementsTestDb.cjs')
const target=requirementsTestUrl(),generated=requirementsClient(target,{namespace:true})
// Commands and database results must share the generated Decimal runtime.
require.cache[require.resolve('@prisma/client')]={exports:generated}
process.env.DATABASE_URL=target;process.env.DIRECT_URL=target
process.env.JWT_SECRET='synthetic-requirements-test-not-a-real-secret-2026'
const {createEngagement,programEngagement,getEngagement}=require('../src/modules/appointments/engagements')
const {withAgendaTransaction,enrollBooking,rescheduleSession}=require('../src/modules/appointments/application')
const {readAvailability}=require('../src/modules/appointments/queries')
const {saveServiceProfile}=require('../src/modules/appointments/profiles')
const {saveCalendar}=require('../src/modules/appointments/calendars')
test('complete requirements stay atomic under real PostgreSQL scheduling and retries',async t=>{
 const db=new generated.PrismaClient({datasources:{db:{url:target}}});t.after(()=>db.$disconnect())
 const company=await db.company.create({data:{name:'Synthetic requirements concurrency',code:randomUUID().slice(0,12)}})
 const role=await db.role.create({data:{name:'Synthetic '+randomUUID()}})
 const actor=await db.user.create({data:{name:'Synthetic operator',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id}})
 const branch=await db.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'REQ'}})
 await db.userCompany.create({data:{company_id:company.id,user_id:actor.id}})
 await db.userBranch.create({data:{branch_id:branch.id,user_id:actor.id}})
 await db.companyModule.create({data:{company_id:company.id,module_code:'appointments',status:'ACTIVE'}})
 await db.systemSetting.create({data:{company_id:company.id,key:'inventory_services_enabled',value:'true',type:'boolean'}})
 const scope={companyId:company.id,branchId:branch.id,branchIds:[branch.id],userId:actor.id,permissions:[],isAdmin:true}
 const category=await db.productCategory.create({data:{company_id:company.id,name:'Synthetic services'}}),status=await db.stockStatus.create({data:{name:'Synthetic '+randomUUID()}})
 const contact=await db.supplier.create({data:{company_id:company.id,name:'Synthetic customer',contact:'Synthetic',party_type:'CUSTOMER'}})
 const resources=[]
 for(let i=0;i<2;i++)resources.push(await db.scheduleResource.create({data:{company_id:company.id,branch_id:branch.id,name:'Synthetic equipment '+i,type:'EQUIPMENT',portable:true,person_capacity:20}}))
 const ids=resources.map(r=>r.id),req={id:randomUUID(),kind:'RESOURCE',name:'Equipo del evento',quantity:2,optionIds:ids}
 const profile={enabled:true,schedulingStyle:'APPOINTMENT',mode:'INDIVIDUAL',durationPolicy:'FIXED',durationMinutes:45,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:false,requiresResource:false,branchIds:[branch.id],providerIds:[],resourceIds:ids,assignmentRequirements:[req],allowedVenueKinds:['BRANCH'],instructions:'',expectedVersion:0}
 const calendar={timezone:'America/Guatemala',expectedVersion:0,weekly:Array.from({length:7},(_,i)=>({weekday:i+1,from:'00:00',to:'24:00'})),exceptions:[]}
 await withAgendaTransaction(db,company.id,async tx=>{
  await saveCalendar(tx,scope,'branch',branch.id,calendar)
  for(const r of resources)await saveCalendar(tx,scope,'resource',r.id,{...calendar,weekly:[],inheritBranch:true})
 })
 async function service(style='APPOINTMENT'){
  const p=await db.product.create({data:{company_id:company.id,name:'Synthetic '+style,kind:'SERVICE',service_unit_label:'sesión',category_id:category.id,status_id:status.id,price:'25',cost:'0'}})
  await withAgendaTransaction(db,company.id,tx=>saveServiceProfile(tx,scope,p.id,{...profile,schedulingStyle:style,mode:style==='CLASS'?'GROUP':'INDIVIDUAL',capacity:style==='CLASS'?3:1}))
  return p.id
 }
 const productId=await service(),startsAt=require('luxon').DateTime.now().setZone('America/Guatemala').plus({days:2}).set({hour:9,minute:0,second:0,millisecond:0}).toUTC().toISO()
 const at=days=>new Date(new Date(startsAt).getTime()+days*86400000).toISOString()
 const input=(e,day=0)=>({expectedVersion:e.version,partial:false,idempotencyKey:randomUUID(),programs:[{lineId:e.lines[0].id,quantity:'1',startsAt:at(day),timezone:'America/Guatemala',providerIds:[],resourceIds:ids,acknowledgedConditionsVersion:e.lines[0].conditionsVersion}]})
 const create=lines=>createEngagement(db,scope,{contactId:contact.id,lines:lines||[{productId,quantity:'1'}],idempotencyKey:randomUUID()})
 await t.test('two engagements cannot both reserve the same required equipment; replay has one effect',async()=>{
  const e=[await create(),await create()],requests=e.map(item=>input(item))
  const results=await Promise.allSettled(e.map((item,i)=>programEngagement(db,scope,item.id,requests[i])))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results.map(r=>r.reason?.message)))
  const winner=results.findIndex(r=>r.status==='fulfilled'),loser=1-winner
  assert.equal(results[loser].reason.code,'SLOT_UNAVAILABLE')
  await programEngagement(db,scope,e[winner].id,requests[winner])
  assert.equal(await db.appointmentEngagementSchedule.count({where:{company_id:company.id}}),1)
  assert.equal(await db.appointmentSessionResource.count({where:{company_id:company.id}}),2)
  assert.equal(await db.appointmentRequest.count({where:{company_id:company.id,operation:'PROGRAM_ENGAGEMENT'}}),1)
  assert.equal((await getEngagement(db,scope,e[loser].id)).version,e[loser].version)
 })
 await t.test('a short second selection rolls back the first schedule, history and receipt',async()=>{
  const e=await create([{productId,quantity:'1'},{productId,quantity:'1'}]),request=input(e,1)
  request.programs.push({...request.programs[0],lineId:e.lines[1].id,startsAt:at(2),resourceIds:ids.slice(0,1),acknowledgedConditionsVersion:e.lines[1].conditionsVersion})
  const before=await db.appointmentSession.count({where:{company_id:company.id}})
  await assert.rejects(programEngagement(db,scope,e.id,request),{code:'REQUIREMENTS_INCOMPLETE'})
  assert.equal(await db.appointmentSession.count({where:{company_id:company.id}}),before)
  assert.equal(await db.appointmentEngagementSchedule.count({where:{engagement_id:e.id}}),0)
  assert.equal(await db.appointmentEngagementHistory.count({where:{engagement_id:e.id,action:'PROGRAMMED'}}),0)
  assert.equal(await db.appointmentRequest.count({where:{company_id:company.id,idempotency_key:request.idempotencyKey}}),0)
  assert.equal((await getEngagement(db,scope,e.id)).version,e.version)
 })
 let classSession
 await t.test('configured work and classes enforce the same requirements in their persisted policy',async()=>{
  for(const [i,style]of ['WORK','CLASS'].entries()){
   const p=await service(style),e=await create([{productId:p,quantity:'1'}]),request=input(e,3+i)
   const incomplete={...request,idempotencyKey:randomUUID(),programs:request.programs.map(p=>({...p,resourceIds:ids.slice(0,1)}))}
   await assert.rejects(programEngagement(db,scope,e.id,incomplete),{code:'REQUIREMENTS_INCOMPLETE'})
   await programEngagement(db,scope,e.id,request)
   const schedule=await db.appointmentEngagementSchedule.findFirst({where:{engagement_id:e.id}})
   const session=await db.appointmentSession.findUnique({where:{id:schedule.session_id},include:{resources:true}})
   assert.equal(session.policy_snapshot.assignmentRequirements[0].quantity,2);assert.equal(session.resources.length,2)
   if(style==='CLASS')classSession=session
  }
 })
 await t.test('class search, enrollment and moving retain frozen requirements after the profile changes',async()=>{
  const p=classSession.product_id,third=await db.scheduleResource.create({data:{company_id:company.id,branch_id:branch.id,name:'Synthetic third equipment',type:'EQUIPMENT',portable:true,person_capacity:20}})
  await withAgendaTransaction(db,company.id,async tx=>{
   await saveCalendar(tx,scope,'resource',third.id,{...calendar,weekly:[],inheritBranch:true})
   await saveServiceProfile(tx,scope,p,{...profile,expectedVersion:1,schedulingStyle:'CLASS',mode:'GROUP',capacity:3,resourceIds:[...ids,third.id],assignmentRequirements:[{...req,quantity:3,optionIds:[...ids,third.id]}]})
  })
  const slots=await readAvailability(db,scope,{productId:p,from:at(4),to:at(5),providerIds:[],resourceIds:[]})
  assert.ok(slots.some(s=>s.sessionId===classSession.id),'Previously created class must remain discoverable without the newly required equipment')
  await enrollBooking(db,scope,classSession.id,{contactId:contact.id,quantity:'1',notes:'Synthetic',idempotencyKey:randomUUID()})
  await rescheduleSession(db,scope,classSession.id,{startsAt:at(6),timezone:'America/Guatemala',providerIds:[],resourceIds:ids,expectedVersion:classSession.version,reason:'Synthetic move',idempotencyKey:randomUUID()})
  const moved=await db.appointmentSession.findUnique({where:{id:classSession.id},include:{resources:true}})
  assert.equal(moved.resources.length,2);assert.equal(moved.policy_snapshot.assignmentRequirements[0].quantity,2)
 })
 t.diagnostic('Synthetic loopback database only; no active client regeneration, sales or provider requests')
})
