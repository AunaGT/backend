const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {parseEngagement}=require('../src/modules/appointments/engagements')
const {parsePrograms}=require('../src/modules/appointments/engagementScheduling')
const key=()=>crypto.randomUUID()
test('engagement input never accepts client amounts, payment state or mixed commercial sources',()=>{
  const quoteId=key(),contactId=key()
  assert.deepEqual(parseEngagement({quoteId,idempotencyKey:'qa-test-attempt'}),{quoteId,idempotencyKey:'qa-test-attempt'})
  for(const extra of [{total:'1'},{paid:true},{lines:[]},{contactId},{unitPrice:'1'}])assert.throws(()=>parseEngagement({quoteId,idempotencyKey:'qa-test-attempt',...extra}),{code:'INVALID_INPUT'})
  assert.throws(()=>parseEngagement({contactId,lines:[],idempotencyKey:'qa-test-attempt'}),{code:'INVALID_INPUT'})
  assert.throws(()=>parseEngagement({quoteId,idempotencyKey:'a'.repeat(65)}),{code:'INVALID_INPUT'})
})
test('scheduling rejects unbounded, ambiguous or financial fields before starting a transaction',()=>{
  for(const programs of [[],Array(101).fill({})])assert.throws(()=>parsePrograms({programs,expectedVersion:1,idempotencyKey:'qa-test-attempt'}),{code:'INVALID_INPUT'})
  const program={lineId:key(),quantity:'1',startsAt:'2030-01-01T15:00:00Z',timezone:'America/Guatemala',acknowledgedConditionsVersion:'a'.repeat(64)}
  assert.equal(parsePrograms({programs:[program],expectedVersion:1,idempotencyKey:'qa-test-attempt',partial:true}).partial,true)
  for(const extra of [{unitPrice:'1'},{contactId:key()},{sessionId:key()}])assert.throws(()=>parsePrograms({programs:[{...program,...extra}],expectedVersion:1,idempotencyKey:'qa-test-attempt'}),{code:'INVALID_INPUT'})
})
