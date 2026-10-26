const test=require('node:test'),assert=require('node:assert/strict')
const {quoteHarness}=require('./helpers/packageQuoteHarness'),{id}=require('./helpers/packageFixtures')
const {publicConditionsFromRow,publicServiceConditions}=require('../src/modules/appointments')
const {conditionInfo}=require('../src/modules/appointments/commercialQueries')
const {createEngagementSchedule}=require('../src/modules/appointments/engagementScheduling')
const requirement={id:id(700),kind:'PROVIDER',name:'Personal de atención',quantity:2,optionIds:[id(701),id(702)]}
const summary=[{name:'Personal de atención',kind:'PROVIDER',quantity:2}]
const profile=()=>({enabled:true,version:1,scheduling_style:'WORK',duration_policy:'FIXED',duration_minutes:60,allowed_venue_kinds:['EVENT_VENUE'],public_instructions:'Acceso lateral',branches:[{branch_id:id(201)}],assignment_requirements:[structuredClone(requirement)]})
test('public service summary freezes names and quantities without directory options or identifiers',()=>{
 const row=profile(),saved=publicConditionsFromRow(row)
 assert.deepEqual(saved.assignmentRequirements,summary)
 row.assignment_requirements[0].quantity=3;row.assignment_requirements[0].optionIds.push(id(703))
 assert.deepEqual(saved.assignmentRequirements,summary)
 const safe=publicServiceConditions({...saved,assignmentRequirements:[{...requirement,providerName:'PRIVATE',salary:'PRIVATE'}]})
 assert.deepEqual(safe.assignmentRequirements,summary)
 assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|optionIds|00000000/)
})
test('both free service and package component retain offered requirements after service configuration changes',async()=>quoteHarness(async f=>{
 f.state.products.find(p=>p.id===id(20)).service_schedule_profile=profile()
 for(const body of [{items:[],packages:[f.selection()]},{items:[{product_id:id(20),qty:'1'}]}]){
  const created=await f.invoke('create',body);assert.equal(created.error,undefined)
  const offered=structuredClone(f.document())
  assert.deepEqual(offered.lines.find(l=>l.item_kind==='SERVICE').service_schedule_snapshot.assignmentRequirements,summary)
  if(body.packages)assert.deepEqual(offered.package_groups[0].components[0].serviceConditions.assignmentRequirements,summary)
  f.state.products.find(p=>p.id===id(20)).service_schedule_profile.assignment_requirements[0].quantity=3
  assert.deepEqual(f.document(),offered,'changing the current profile must not rewrite the saved agreement')
  f.state.products.find(p=>p.id===id(20)).service_schedule_profile=profile()
 }
}))
test('private options invalidate the review hash even when the offered public summary is unchanged',async()=>{
 const current=profile(),product={kind:'SERVICE',deleted:false,available_for_sale:true},offered=publicConditionsFromRow(current)
 const first=conditionInfo(current,product,id(201),offered)
 current.assignment_requirements[0].optionIds=[id(701),id(703)]
 const changed=conditionInfo(current,product,id(201),offered)
 assert.notEqual(changed.conditionsVersion,first.conditionsVersion)
 assert.deepEqual(changed.currentConditions,first.currentConditions)
 assert.equal(changed.conditionsChanged,false)
 const db={appointmentEngagementSchedule:{findMany:async()=>[]},product:{findFirst:async()=>({...product,service_schedule_profile:current})}}
 const line={id:id(710),product_id:id(20),item_kind:'SERVICE',item_name:'Atención',qty:'1',quantity_decimals:0,service_schedule_snapshot:offered}
 await assert.rejects(()=>createEngagementSchedule(db,{companyId:id(200),branchId:id(201)},{},line,{quantity:'1',acknowledgedConditionsVersion:first.conditionsVersion},new Date()),{code:'CONDITIONS_CHANGED'})
})
test('legacy public snapshots keep their shape and absent requirements do not create a false change',()=>{
 const row=profile();delete row.assignment_requirements
 const offered=publicConditionsFromRow(row)
 assert.equal(Object.hasOwn(offered,'assignmentRequirements'),false)
 assert.equal(conditionInfo(row,{kind:'SERVICE',available_for_sale:true},id(201),offered).conditionsChanged,false)
})
