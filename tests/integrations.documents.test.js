const test=require('node:test'),assert=require('node:assert/strict')
const {draftFixture}=require('./helpers/integrationDraftDb'),{COMPANY,OWNER,BRANCH}=require('./helpers/integrationsDb')
test('own-document reads use current branch and explicit safe projections',async()=>{
 const {getIntegrationDocument,listIntegrationDocuments}=require('../src/modules/integrations/documents')
 const f=draftFixture(),id='44444444-4444-4444-8444-444444444444',ctx={companyId:COMPANY,integrationId:OWNER,scopes:['quotes.read'],branches:[{id:BRANCH}]}
 f.operations.push({company_id:COMPANY,integration_id:OWNER,type:'QUOTE',document_id:id,branch_id:BRANCH,currency_code:'GTQ',external_reference:null,document:{id,branch_id:BRANCH,doc_type:'QUOTE',reference:'Q-QA-000001',status:'SENT',subtotal:'10',discount_total:'0',total:'10',created_at:new Date(),updated_at:new Date(),integration_revision:OWNER,valid_until:new Date(),customer:'private',notes:'private',public_token:'private',lines:[]}})
 const detail=await getIntegrationDocument(f.db,ctx,'QUOTE',id);assert.equal(detail.status,'SENT');assert.doesNotMatch(JSON.stringify(detail),/private|notes|customer|token/)
 assert.equal((await listIntegrationDocuments(f.db,ctx,'QUOTE',{})).items.length,1)
 for(const change of [{integrationId:'foreign'},{companyId:'foreign'},{branches:[]},{scopes:[]}])await assert.rejects(()=>getIntegrationDocument(f.db,{...ctx,...change},'QUOTE',id),e=>[403,404].includes(e.status))
})
test('detail version and lines use one RepeatableRead snapshot; list DTO stays unchanged',async()=>{
 const {getIntegrationDocument,listIntegrationDocuments}=require('../src/modules/integrations/documents')
 const f=draftFixture(),id='44444444-4444-4444-8444-444444444444',ctx={companyId:COMPANY,integrationId:OWNER,scopes:['quotes.read'],branches:[{id:BRANCH}]},updated=new Date('2026-10-26T12:00:00Z')
 f.operations.push({company_id:COMPANY,integration_id:OWNER,type:'QUOTE',document_id:id,branch_id:BRANCH,currency_code:'GTQ',document:{id,branch_id:BRANCH,doc_type:'QUOTE',status:'DRAFT',total:'0',created_at:updated,updated_at:updated,integration_revision:OWNER,lines:[]}})
 let isolation;const transaction=f.db.$transaction;f.db.$transaction=(fn,options)=>{isolation=options?.isolationLevel;return transaction(fn)}
 const dto=await getIntegrationDocument(f.db,ctx,'QUOTE',id)
 assert.equal(isolation,'RepeatableRead');assert.equal(dto.version,'auna-draft-v1:'+OWNER);assert.equal(dto.updatedAt,updated.toISOString())
 const list=await listIntegrationDocuments(f.db,ctx,'QUOTE',{});assert.equal(Object.hasOwn(list.items[0],'version'),false);assert.equal(Object.hasOwn(list.items[0],'updatedAt'),false)
})
