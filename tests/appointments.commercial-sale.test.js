const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
let parseSale
try{({parseSale}=require('../src/modules/appointments/engagementSales'))}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}
test('issuing accepts terms, never browser prices, payment state or internal settlement marker',()=>{
  assert.equal(typeof parseSale,'function')
  const input={expectedVersion:1,idempotencyKey:crypto.randomUUID(),paymentCondition:'CREDIT',dueDate:'2026-12-30'}
  assert.equal(parseSale(input).paymentCondition,'CREDIT')
  for(const key of ['total','lines','paid','saleId','settlement_source','committedAmount'])assert.throws(()=>parseSale({...input,[key]:'tampered'}),{code:'INVALID_INPUT'})
})
