require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {parseProfile}=require('../src/modules/appointments/domain/validation')
const {saveServiceProfile}=require('../src/modules/appointments/profiles')
const {publicConditionsFromRow}=require('../src/modules/appointments')
const {conditionInfo}=require('../src/modules/appointments/commercialQueries')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const requirement={id:id(10),kind:'PROVIDER',name:'Intervención especial',quantity:1,optionIds:[id(20)]}
const input={enabled:true,mode:'INDIVIDUAL',schedulingStyle:'WORK',durationPolicy:'EDITABLE',durationMinutes:240,beforeMinutes:15,afterMinutes:15,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'MANUAL',capacity:1,requiresProvider:false,requiresResource:false,branchIds:[id(2)],providerIds:[id(20)],resourceIds:[],instructions:'',assignmentRequirements:[{...requirement,attendanceMode:'INTERVENTION'}]}
const scope={companyId:id(1),branchId:id(2),branchIds:[id(2)],userId:id(3),permissions:['appointments.view','appointments.configure','products.view']}
function fixture(){
 let row=null;const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'}]},systemSetting:{findUnique:async()=>({value:'true'})},product:{findFirst:async()=>({id:id(4),kind:'SERVICE'})},
  branch:{findMany:async()=>[{id:id(2),name:'Sucursal'}]},serviceProvider:{findMany:async()=>[{id:id(20),user_id:id(21),branches:[{branch_id:id(2)}]}]},scheduleResource:{findMany:async()=>[]},
  serviceScheduleProfile:{findFirst:async()=>row,create:async({data})=>(row={...data,id:id(5),branches:[{branch_id:id(2)}]}),updateMany:async({data,where})=>{if(where.version!==row.version)return{count:0};row={...row,...data,version:row.version+1};return{count:1}}}}
 for(const key of ['serviceScheduleBranch','serviceScheduleProvider','serviceScheduleResource'])db[key]={deleteMany:async()=>{},createMany:async()=>{}}
 return{db,row:()=>row}
}
test('intervention requirements are WORK-only and missing legacy mode keeps the old full requirement',()=>{
 assert.equal(parseProfile(input).assignmentRequirements[0].attendanceMode,'INTERVENTION')
 assert.throws(()=>parseProfile({...input,schedulingStyle:'APPOINTMENT'}),{code:'INVALID_INPUT'})
 const old=parseProfile({...input,assignmentRequirements:[requirement]})
 assert.equal(old.assignmentRequirements[0].attendanceMode??'FULL','FULL')
 assert.throws(()=>parseProfile({...input,assignmentRequirements:[{...requirement,attendanceMode:'ANY'}]}),{code:'INVALID_INPUT'})
})
test('an older editor omitting mode by stable requirement ID cannot erase the saved attendance policy',async()=>{
 const f=fixture();await saveServiceProfile(f.db,scope,id(4),input)
 const before=structuredClone(f.row())
 const next=await saveServiceProfile(f.db,scope,id(4),{...input,assignmentRequirements:[requirement],expectedVersion:1})
 assert.equal(next.profile.assignmentRequirements[0].attendanceMode,'INTERVENTION')
 assert.equal(before.assignment_requirements[0].attendanceMode,'INTERVENTION')
 await assert.rejects(()=>saveServiceProfile(f.db,scope,id(4),{...input,expectedVersion:1}),{code:'STALE_VERSION'})
})
test('attendance mode changes new review hashes but not frozen offered conditions or private public fields',()=>{
 const row={enabled:true,version:1,scheduling_style:'WORK',duration_policy:'EDITABLE',duration_minutes:240,allowed_venue_kinds:['EVENT_VENUE'],branches:[{branch_id:id(2)}],assignment_requirements:[{...requirement,attendanceMode:'FULL'}]},product={kind:'SERVICE',available_for_sale:true}
 const offered=publicConditionsFromRow(row),first=conditionInfo(row,product,id(2),offered)
 row.assignment_requirements[0].attendanceMode='INTERVENTION'
 const next=conditionInfo(row,product,id(2),offered)
 assert.notEqual(next.conditionsVersion,first.conditionsVersion);assert.equal(next.conditionsChanged,true)
 assert.equal(offered.assignmentRequirements[0].attendanceMode,'FULL')
 assert.equal(next.currentConditions.assignmentRequirements[0].attendanceMode,'INTERVENTION')
 assert.doesNotMatch(JSON.stringify(next.currentConditions),/optionIds|entityId|00000000/)
})
test('older generated runtime cannot enable a policy that needs undeployed timeline storage',async()=>{
 const f=fixture();f.db._runtimeDataModel={models:{AppointmentSession:{fields:[]}}}
 await assert.rejects(()=>saveServiceProfile(f.db,scope,id(4),input),{code:'TIMELINE_NOT_READY'})
 assert.equal(f.row(),null)
})
