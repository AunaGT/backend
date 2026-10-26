require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {computeSlots}=require('../src/modules/appointments/domain/availability')
const {assertServiceInterval}=require('../src/modules/appointments/serviceScheduling')
const {applyConfiguredActivityPolicy}=require('../src/modules/appointments/configuredActivities')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const requirement=(kind='RESOURCE')=>({id:id(10),name:'Equipo de atención',kind,quantity:2,optionIds:[id(20),id(21),id(22)]})
function fixture(){
 const branch={owner_type:'branch',branch_id:id(2),timezone:'America/Guatemala',rules:[{weekday:1,from_minute:540,to_minute:720}],exceptions:[]}
 return{profile:{enabled:true,mode:'INDIVIDUAL',schedulingStyle:'APPOINTMENT',durationPolicy:'FIXED',durationMinutes:30,beforeMinutes:0,afterMinutes:0,intervalMinutes:30,leadMinutes:0,horizonDays:60,requiresProvider:false,requiresResource:true,capacity:1,assignmentRequirements:[requirement()]},
 calendars:[branch,...[20,21,22].map(n=>({...branch,owner_type:'resource',branch_id:null,resource_id:id(n),inherit_branch:true,rules:[]}))],providers:[],resources:[20,21,22].map(n=>({id:id(n),type:'EQUIPMENT',portable:true,person_capacity:null})),sessions:[],bookings:[],absenceDates:[],
 from:'2026-10-12T15:00:00Z',to:'2026-10-12T18:00:00Z',now:new Date('2026-10-12T12:00:00Z')}
}
test('available slots satisfy every required equipment place and can choose a free alternative',()=>{
 const f=fixture();assert.deepEqual(computeSlots(f)[0].resourceIds,[id(20),id(21)])
 f.busyAssignments=[{sessionId:'other',start:Date.parse(f.from),end:Date.parse('2026-10-12T16:00Z'),providerIds:[],resourceIds:[id(20)]}]
 assert.deepEqual(computeSlots(f)[0].resourceIds,[id(21),id(22)])
 f.resources.pop();assert.equal(computeSlots(f)[0].startsAt,'2026-10-12T16:00:00.000Z')
})
test('explicit incomplete selection fails instead of silently reserving another equipment',()=>{
 const f=fixture();f.resourceIds=[id(20)]
 assert.deepEqual(computeSlots(f),[])
 assert.throws(()=>assertServiceInterval(f,{startsAt:f.from,timezone:'America/Guatemala'},f.now),{code:'REQUIREMENTS_INCOMPLETE'})
})
test('the entire occupied interval includes travel and preparation for all required equipment',()=>{
 const f=fixture();f.resources.pop();f.profile.beforeMinutes=15;f.outboundMinutes=15;f.returnMinutes=30
 f.busyAssignments=[{sessionId:'other',start:Date.parse('2026-10-12T16:30Z'),end:Date.parse('2026-10-12T17:00Z'),providerIds:[],resourceIds:[id(21)]}]
 assert.deepEqual(computeSlots(f).map(s=>s.startsAt),['2026-10-12T15:30:00.000Z'])
})
test('employee aliases and absence cannot fill two required professional places',()=>{
 const f=fixture();f.profile.requiresResource=false;f.profile.requiresProvider=true;f.profile.assignmentRequirements=[requirement('PROVIDER')]
 f.providers=[20,21].map(n=>({id:id(n),user_id:id(90),employee_id:id(n+100)}));f.resources=[]
 f.calendars=f.calendars.map(c=>c.owner_type==='resource'?{...c,owner_type:'provider',provider_id:c.resource_id,resource_id:undefined}:c)
 assert.deepEqual(computeSlots(f),[])
 f.providers[1].user_id=id(91);f.absenceDates=[{employee_id:id(121),work_date:new Date('2026-10-12'),status:'AUSENTE'}]
 assert.deepEqual(computeSlots(f),[])
})
test('existing class uses its frozen requirements rather than adding the new profile obligations',()=>{
 const f=fixture();f.profile.mode='GROUP';f.profile.capacity=5;f.productId=id(4)
 const session={id:id(50),product_id:id(4),branch_id:id(2),record_type:'SCHEDULED_SERVICE',mode:'GROUP',status:'SCHEDULED',starts_at:new Date(f.from),ends_at:new Date('2026-10-12T15:30Z'),occupied_from:new Date(f.from),occupied_until:new Date('2026-10-12T15:30Z'),capacity:5,timezone:'America/Guatemala',providers:[],resources:[{resource_id:id(20)}],policy_snapshot:{...f.profile,assignmentRequirements:[]}}
 f.sessions=[session];assert.equal(computeSlots(f)[0]?.sessionId,session.id)
 f.sessions[0].policy_snapshot.assignmentRequirements=[requirement()]
 assert.deepEqual(computeSlots(f),[],'enrolling cannot add the missing equipment to the class')
})
test('configured work enforces required quantities and keeps its original policy on editing',async()=>{
 const f=fixture(),policy={...f.profile,schedulingStyle:'WORK',serviceScheduling:'CONFIGURED',providerIds:[],resourceIds:[id(20),id(21),id(22)],allowedVenueKinds:['BRANCH']}
 const old={product_id:id(4),policy_snapshot:policy},input={productId:id(4),serviceScheduling:'CONFIGURED',providerIds:[],resourceIds:[id(20)],setupMinutes:0,teardownMinutes:0,venue:{kind:'BRANCH'},startsAt:'2030-01-01T15:00:00Z',endsAt:'2030-01-01T15:30:00Z',timezone:'America/Guatemala'}
 await assert.rejects(()=>applyConfiguredActivityPolicy({}, {companyId:id(1),branchId:id(2)},input,old),{code:'REQUIREMENTS_INCOMPLETE'})
 const db={serviceProvider:{findMany:async()=>[]}}
 const out=await applyConfiguredActivityPolicy(db,{companyId:id(1),branchId:id(2)},{...input,resourceIds:[id(20),id(21)]},old)
 assert.deepEqual(out.policySnapshot.assignmentRequirements,[requirement()])
})
