const test=require('node:test'),assert=require('node:assert/strict')
let presentCommercialPreparation
try{({presentCommercialPreparation}=require('../src/modules/appointments/commercialDrafts'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('scheduler preparation result never reveals financial identifiers',()=>{
  assert.equal(typeof presentCommercialPreparation,'function')
  assert.deepEqual(presentCommercialPreparation({state:'READY',saleId:'private'},false),{commercialPreparation:'READY'})
  assert.deepEqual(presentCommercialPreparation({state:'PENDING',reason:'INTEGRATION_DISABLED'},false),{commercialPreparation:'PENDING',commercialPreparationReason:'INTEGRATION_DISABLED'})
})
test('cancellation only cancels an entirely affected single-service draft',()=>{
  const {draftDispositionForImpact}=require('../src/modules/appointments/commercialDrafts')
  assert.equal(typeof draftDispositionForImpact,'function')
  const line={item_kind:'SERVICE',qty:'2',schedules:[{state:'CANCELLED',quantity:'1'}]}
  assert.equal(draftDispositionForImpact({sale_id:null,lines:[line]}),'REVIEW')
  assert.equal(draftDispositionForImpact({sale_id:null,lines:[{...line,qty:'1'}]}),'CANCEL')
  assert.equal(draftDispositionForImpact({sale_id:'confirmed',lines:[{...line,qty:'1'}]}),'NONE')
  assert.equal(draftDispositionForImpact({sale_id:null,lines:[line,{item_kind:'STANDARD',qty:'1',schedules:[]}]}),'REVIEW')
})
test('pending integration hides agreed money even from catalog readers and a link alone is not READY',()=>{
  const {presentBooking}=require('../src/modules/appointments/presentation')
  const row={id:'b',session_id:'s',status:'CONFIRMED',commercial_snapshot:{name:'Consulta',unitPrice:'150',total:'150',preparationReason:'INTEGRATION_DISABLED'},session:{product_id:'p',providers:[],resources:[],engagement_schedules:[]},engagement_schedules:[]}
  const scope={isAdmin:false,permissions:['appointments.view','products.view']}
  const pending=presentBooking(row,scope)
  assert.equal(pending.commercial,null);assert.equal(pending.commercialPreparation,'PENDING');assert.equal(pending.commercialPreparationReason,'INTEGRATION_DISABLED')
  row.engagement_schedules=[{engagement_id:'e',line:{engagement:{origin_sale:null}}}]
  assert.equal(presentBooking(row,scope).commercialPreparation,'PENDING')
  row.engagement_schedules[0].line.engagement.origin_sale={id:'draft'}
  const ready=presentBooking(row,scope)
  assert.equal(ready.commercialPreparation,'READY');assert.equal(Object.hasOwn(ready,'commercialPreparationReason'),false)
  assert.equal(ready.commercial,null)
})
