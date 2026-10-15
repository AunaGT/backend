const test=require('node:test'),assert=require('node:assert/strict')
test('generic sale status cannot confirm or resurrect an Agenda document',()=>{
  const {assertGenericSaleStatusChange}=require('../src/modules/sales/commercialState')
  assert.equal(typeof assertGenericSaleStatusChange,'function')
  const draft={origin_engagement_id:'origin',status:{name:'Borrador'}}
  assert.throws(()=>assertGenericSaleStatusChange(draft,'Completada'),{code:'ENGAGEMENT_OWNS_SALE'})
  assert.throws(()=>assertGenericSaleStatusChange(draft,'Cancelada'),{code:'ENGAGEMENT_OWNS_SALE'})
  assert.throws(()=>assertGenericSaleStatusChange({status:{name:'Completada'}},'Borrador'),{code:'INVALID_TRANSITION'})
  assert.doesNotThrow(()=>assertGenericSaleStatusChange({status:{name:'Completada'}},'Cancelada'))
})
test('confirmation parser never trusts browser document or fiscal fields',()=>{
  require('./setup-env')
  const {parseSale}=require('../src/modules/appointments/engagementSales')
  const base={expectedVersion:1,idempotencyKey:require('node:crypto').randomUUID()}
  for(const key of ['draftSaleId','origin_engagement_id','fiscalState','confirmedAt'])assert.throws(()=>parseSale({...base,[key]:'tampered'}),{code:'INVALID_INPUT'})
})
