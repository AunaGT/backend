const test=require('node:test'),assert=require('node:assert/strict')
const {listTemplates,saveDraft}=require('../src/modules/config/documentTemplates/service')
test('sales permissions do not grant template access and managing templates does not imply publishing',async()=>{
  const scope={companyId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',permissions:['sales.view']}
  await assert.rejects(listTemplates({},scope,{}),{status:403})
  await assert.rejects(saveDraft({},scope,{}),{status:403})
})
