const test=require('node:test'),assert=require('node:assert/strict')
let publicServiceConditions
try { ({publicServiceConditions}=require('../src/modules/appointments/domain/publicServiceConditions')) } catch(e) { if(e.code!=='MODULE_NOT_FOUND') throw e }
test('public service conditions whitelist freezes a detached public snapshot',()=>{
  assert.equal(typeof publicServiceConditions,'function')
  const profile={schedulingStyle:'WORK',durationPolicy:'FIXED',durationMinutes:60,allowedVenueKinds:['EVENT_VENUE'],publicInstructions:'Llegar al acceso principal',instructions:'Privado',providerIds:['secret'],notes:'Privado',enabled:false}
  const result=publicServiceConditions(profile)
  assert.deepEqual(result,{version:1,schedulingStyle:'WORK',durationPolicy:'FIXED',durationMinutes:60,allowedVenueKinds:['EVENT_VENUE'],publicInstructions:'Llegar al acceso principal'})
  profile.allowedVenueKinds.push('HOME');profile.publicInstructions='Cambió'
  assert.equal(result.allowedVenueKinds.length,1)
  assert.equal(result.publicInstructions,'Llegar al acceso principal')
  assert.equal(publicServiceConditions(null),null)
})
test('public instructions are explicit, bounded and optional for older profile callers',()=>{
  const {parseProfile}=require('../src/modules/appointments/domain/validation')
  const raw={enabled:false,mode:'INDIVIDUAL',durationMinutes:45,beforeMinutes:0,afterMinutes:0,intervalMinutes:15,leadMinutes:0,horizonDays:60,cancellationHours:24,confirmation:'AUTOMATIC',capacity:1,requiresProvider:false,requiresResource:false,branchIds:[],providerIds:[],resourceIds:[],instructions:'No publicar'}
  assert.equal(parseProfile({...raw,publicInstructions:'Información pública'}).publicInstructions,'Información pública')
  assert.equal(Object.hasOwn(parseProfile(raw),'publicInstructions'),false)
  assert.throws(()=>parseProfile({...raw,publicInstructions:'a'.repeat(2001)}))
})
