const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {fiscalState}=require('../src/modules/sales/externalInvoices')
test('waiting for a connector is not an authorized or malformed invoice',()=>{
  assert.equal(fiscalState([{status:'PENDING_CONNECTOR',provider:null,authorization:null}]),'PENDING_CONNECTOR')
  assert.equal(fiscalState([{status:'PENDING_CONNECTOR',authorization:'FORGED'}]),'REVIEW_REQUIRED')
})
test('an inactive company setting differs from an unrequested invoice',()=>{
  assert.equal(require('../src/modules/sales/commercialState').saleCommercialView({status:{name:'Completada'},sale_dtes:[]},{fiscalEnabled:false}).fiscalState,'DISABLED')
})
test('fiscal requests reject browser-controlled certificate data',()=>{
  const api=require('../src/modules/sales/fiscalRequests')
  const input={expectedVersion:1,idempotencyKey:crypto.randomUUID()}
  assert.deepEqual(api.parseFiscalRequest(input),input)
  for(const key of ['authorization','provider','series','status','total','companyId'])assert.throws(()=>api.parseFiscalRequest({...input,[key]:'FORGED'}),{code:'INVALID_INPUT'})
})
