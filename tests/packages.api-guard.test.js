const test=require('node:test'),assert=require('node:assert/strict')
const {assertMutableDraft}=require('../src/modules/integrations/draftDocument')
const draft=()=>({status:'DRAFT',sales_channel:'ONLINE',payment_condition:'CASH',discount_total:'0',customer_contact_id:'customer',lines:[]})
test('API key cannot edit or discard an internally configured package agreement',()=>{
  for(const options of [{},{replaceItems:true}]){
    const document={...draft(),package_groups:[{schemaVersion:1,state:'INCOMPLETE'}]}
    assert.throws(()=>assertMutableDraft(document,options),{status:409,integrationCode:'DOCUMENT_REVIEW_REQUIRED'})
  }
  assert.doesNotThrow(()=>assertMutableDraft({...draft(),package_groups:null}))
  assert.doesNotThrow(()=>assertMutableDraft({...draft(),package_groups:[]}))
})
test('orphan package line also requires review rather than allowing API replacement',()=>{
  assert.throws(()=>assertMutableDraft({...draft(),lines:[{package_component_key:'orphan'}]}),{status:409,integrationCode:'DOCUMENT_REVIEW_REQUIRED'})
})
