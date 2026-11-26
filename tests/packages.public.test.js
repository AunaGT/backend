const test=require('node:test'),assert=require('node:assert/strict')
const {agreementFixture}=require('./helpers/packageAgreementFixture'),{quoteHarness}=require('./helpers/packageQuoteHarness'),{id}=require('./helpers/packageFixtures')
const {buildPackageGroups,publicPackageGroups}=require('../src/services/commercialPackages')
function contaminate(groups){groups[0].privateCost='SECRET_COST';groups[0].weight='SECRET_WEIGHT';groups[0].resourceIds=['SECRET_RESOURCE'];groups[0].components[0].unitCost='SECRET_UNIT_COST';return groups}
function safe(groups){assert.ok(Array.isArray(groups),'commercial groups are present');assert.equal(groups[0].variantName,'160 unidades');assert.equal(groups[0].components.length,3);assert.doesNotMatch(JSON.stringify(groups),/SECRET_|selection|unitSnapshot|unitRevision|packageId|variantId/)}
test('public projection strips private package metadata without changing the agreed amount',async()=>{
 const f=await agreementFixture(),built=await buildPackageGroups(f.db,f.scope,[f.selection()]);safe(publicPackageGroups(contaminate(built.groups)))
})
test('public quotation returns the saved commercial group and component identity, not private metadata',async()=>quoteHarness(async f=>{
 const built=await buildPackageGroups(f.db,f.scope,[f.selection()]);f.db.systemSetting={findMany:async()=>[{key:'currency_code',value:'USD'}]}
 f.setDocument({id:id(400),doc_type:'QUOTE',status:'SENT',public_token:'token',branch_id:f.scope.branchId,lines:built.lines,package_groups:contaminate(built.groups),total:built.subtotal})
 const {res,error}=await f.invoke('getPublicByToken',{})
 assert.equal(error,undefined);safe(res.body.packageGroups);assert.equal(res.body.lines[0].package_component_key,built.lines[0].package_component_key)
 assert.equal(res.body.currency_code,'GTQ','saved proposal is not relabeled when company currency changes')
}))
test('API own-document read exposes public groups only and preserves the receipt and permissions',async()=>{
 const f=await agreementFixture(),built=await buildPackageGroups(f.db,f.scope,[f.selection()]),{draftFixture}=require('./helpers/integrationDraftDb'),{COMPANY,OWNER,BRANCH}=require('./helpers/integrationsDb')
 const fixture=draftFixture(),documentId=id(400),ctx={companyId:COMPANY,integrationId:OWNER,scopes:['quotes.read'],branches:[{id:BRANCH}]}
 fixture.operations.push({company_id:COMPANY,integration_id:OWNER,type:'QUOTE',document_id:documentId,branch_id:BRANCH,currency_code:'GTQ',document:{id:documentId,branch_id:BRANCH,doc_type:'QUOTE',status:'DRAFT',total:built.subtotal,created_at:new Date(),updated_at:new Date(),integration_revision:OWNER,package_groups:contaminate(built.groups),lines:built.lines}})
 const before=JSON.stringify(fixture.operations),dto=await require('../src/modules/integrations/documents').getIntegrationDocument(fixture.db,ctx,'QUOTE',documentId)
 safe(dto.packageGroups);assert.equal(dto.items[0].packageComponentKey,built.lines[0].package_component_key);assert.equal(JSON.stringify(fixture.operations),before)
 await assert.rejects(()=>require('../src/modules/integrations/documents').getIntegrationDocument(fixture.db,{...ctx,integrationId:id(900)},'QUOTE',documentId),{status:404})
})
test('public order selects saved groups and preserves component identity even without advanced units',async()=>{
 const f=await agreementFixture(),built=await buildPackageGroups(f.db,f.scope,[f.selection()]),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs');let query
 const order={id:id(500),reference:'P-QA',status:'CONFIRMED',branch:{company_id:f.scope.companyId,name:'QA'},package_groups:contaminate(built.groups),lines:built.lines,documentSales:[],total:built.subtotal}
 const db={commercialDocument:{findFirst:async q=>{query=q;return order}},systemSetting:{findMany:async()=>[{key:'currency_code',value:'USD'}],findUnique:async()=>null}}
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db},[require.resolve('../src/modules/platform/service')]:{getCompanyModuleBlock:async()=>null},[require.resolve('../src/services/customerPagesPublic')]:{resolvePublicPortal:async()=>null}},require.resolve('../src/modules/orders/controller'),async controller=>{
  const res=jsonResponse();let error;await controller.getPublicByToken({params:{token:'test'}},res,e=>{error=e})
  assert.equal(error,undefined);assert.equal(query.select.package_groups,true);assert.equal(query.select.lines.select.package_component_key,true);safe(res.body.packageGroups);assert.equal(res.body.lines[0].package_component_key,built.lines[0].package_component_key)
  assert.equal(res.body.currency_code,'GTQ')
 })
})
