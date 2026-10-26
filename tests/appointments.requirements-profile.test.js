require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict')
const {saveServiceProfile,getServiceProfile}=require('../src/modules/appointments/profiles')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope={companyId:id(1),branchId:id(2),branchIds:[id(2),id(3)],userId:id(4),permissions:['appointments.view','appointments.configure','products.view']}
const input={enabled:true,mode:'INDIVIDUAL',durationMinutes:45,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,
 requiresProvider:false,requiresResource:false,branchIds:[id(2)],providerIds:[id(10),id(11)],resourceIds:[id(20),id(21)],instructions:''}
const requirement=(kind='PROVIDER',optionIds=[id(10),id(11)])=>({id:id(30),name:'Equipo de atención',kind,quantity:2,optionIds})
function fixture(){
 let row=null;const writes=[],providers=[10,11].map(n=>({id:id(n),company_id:scope.companyId,user_id:id(n+100),employee_id:null,active:true,branches:[{branch_id:id(2)}]})),resources=[20,21].map(n=>({id:id(n),company_id:scope.companyId,branch_id:id(2),type:'EQUIPMENT',portable:true,active:true}))
 const db={companyModule:{findMany:async()=>[{module_code:'appointments',status:'ACTIVE'}]},systemSetting:{findUnique:async()=>({value:'true'})},
  product:{findFirst:async()=>({id:id(5),company_id:scope.companyId,kind:'SERVICE'})},branch:{findMany:async({where})=>[2,3].filter(n=>where.id.in.includes(id(n))).map(n=>({id:id(n),name:`Sucursal ${n}`,active:true}))},
  serviceProvider:{findMany:async({where})=>providers.filter(p=>where.id.in.includes(p.id)&&p.company_id===where.company_id&&p.active)},scheduleResource:{findMany:async({where})=>resources.filter(r=>where.id.in.includes(r.id)&&r.company_id===where.company_id&&r.active)},
  serviceScheduleProfile:{findFirst:async()=>row,create:async({data})=>{row={id:id(6),...structuredClone(data),branches:input.branchIds.map(branch_id=>({branch_id}))};writes.push(data);return row},updateMany:async({where,data})=>{if(where.version!==row.version)return{count:0};row={...row,...structuredClone(data),version:row.version+1};writes.push(data);return{count:1}}}}
 for(const model of ['serviceScheduleBranch','serviceScheduleProvider','serviceScheduleResource'])db[model]={deleteMany:async()=>{},createMany:async()=>{}}
 return{db,writes,providers,resources,row:()=>row}
}
test('service profile persists quantity requirements, derives mandatory type and old clients cannot erase them',async()=>{
 const f=fixture(),requirements=[requirement()]
 const saved=await saveServiceProfile(f.db,scope,id(5),{...input,assignmentRequirements:requirements})
 assert.deepEqual(saved.profile.assignmentRequirements,requirements);assert.equal(saved.profile.requiresProvider,true)
 assert.deepEqual(f.row().assignment_requirements,requirements)
 const updated=await saveServiceProfile(f.db,scope,id(5),{...input,expectedVersion:1})
 assert.deepEqual(updated.profile.assignmentRequirements,requirements)
 const loaded=await getServiceProfile(f.db,scope,id(5));assert.deepEqual(loaded.profile.assignmentRequirements,requirements)
 const cleared=await saveServiceProfile(f.db,scope,id(5),{...input,assignmentRequirements:[],expectedVersion:2})
 assert.deepEqual(cleared.profile.assignmentRequirements,[]);assert.equal(cleared.profile.requiresProvider,false)
})
test('requirements must have distinct eligible people in every offered branch',async()=>{
 const f=fixture()
 await assert.rejects(()=>saveServiceProfile(f.db,scope,id(5),{...input,branchIds:[id(2),id(3)],assignmentRequirements:[requirement()]}),e=>e.fields?.assignmentRequirements!=null)
 assert.equal(f.writes.length,0)
 f.providers[1].user_id=null;f.providers[1].employee_id=id(80);f.providers[1].employee={user_id:f.providers[0].user_id}
 await assert.rejects(()=>saveServiceProfile(f.db,scope,id(5),{...input,assignmentRequirements:[requirement()]}),e=>e.fields?.assignmentRequirements!=null)
 assert.equal(f.writes.length,0)
})
test('foreign, disabled or unlisted options cannot satisfy a requirement even on a draft',async()=>{
 for(const [i,change]of [f=>{f.providers[1].company_id=id(99)},f=>{f.providers[1].active=false},()=>{}].entries()){
  const f=fixture();change(f)
  await assert.rejects(()=>saveServiceProfile(f.db,scope,id(5),{...input,enabled:false,assignmentRequirements:[requirement('PROVIDER',i===2?[id(10),id(99)]:[id(10),id(11)])]}),{status:400})
  assert.equal(f.writes.length,0)
 }
})
test('a fixed room cannot cover external equipment requirements',async()=>{
 const f=fixture();Object.assign(f.resources[1],{type:'ROOM',portable:false})
 await assert.rejects(()=>saveServiceProfile(f.db,scope,id(5),{...input,allowedVenueKinds:['BRANCH','EVENT_VENUE'],assignmentRequirements:[requirement('RESOURCE',[id(20),id(21)])]}),e=>e.fields?.assignmentRequirements!=null)
 assert.equal(f.writes.length,0)
})
test('stale and unauthorized writes do not change saved requirements',async()=>{
 const f=fixture();await saveServiceProfile(f.db,scope,id(5),{...input,assignmentRequirements:[requirement()]})
 const before=structuredClone(f.row())
 await assert.rejects(()=>saveServiceProfile(f.db,scope,id(5),{...input,assignmentRequirements:[],expectedVersion:0}),{code:'STALE_VERSION'})
 await assert.rejects(()=>saveServiceProfile(f.db,{...scope,permissions:['appointments.view']},id(5),{...input,assignmentRequirements:[],expectedVersion:1}),{status:403})
 assert.deepEqual(f.row(),before)
})
test('internal service picker and saved scheduling policy carry the actual requirements for their forms',async()=>{
 const f=fixture(),requirements=[requirement()]
 await saveServiceProfile(f.db,scope,id(5),{...input,assignmentRequirements:requirements})
 f.db.product.findMany=async()=>[{id:id(5),name:'Atención',price:{toFixed:()=> '25.00'},service_unit_label:'sesión',quantity_decimals:0,available_for_sale:true,service_schedule_profile:f.row()}]
 f.db.product.count=async()=>1
 const out=await require('../src/modules/appointments/queries').listServices(f.db,scope)
 assert.deepEqual(out.items[0].assignmentRequirements,requirements)
 const policy=require('../src/modules/appointments/domain/servicePolicy').publicServicePolicy({assignmentRequirements:requirements})
 assert.deepEqual(policy.assignmentRequirements,requirements)
})
