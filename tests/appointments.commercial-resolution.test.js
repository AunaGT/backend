const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
let parseResolution
try{({parseResolution}=require('../src/modules/appointments/engagementResolution'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('fund decisions require reason and explicit action, and confirmation identifies the pending request',()=>{
  assert.equal(typeof parseResolution,'function')
  const p={action:'REQUEST_REFUND',amount:'10.00',receiptId:crypto.randomUUID(),reason:'Cancelación solicitada',expectedVersion:1,idempotencyKey:crypto.randomUUID()}
  assert.equal(parseResolution(p).amount,'10.00')
  for(const bad of [{...p,amount:'0'},{...p,reason:''},{...p,action:'CONFIRM_REFUND'},{...p,paid:true},{...p,action:'WRITE_TOTAL'}])assert.throws(()=>parseResolution(bad),{code:'INVALID_INPUT'})
})
