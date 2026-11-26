const test=require('node:test'),assert=require('node:assert/strict'),{withMocks}=require('./helpers/reportHarness.cjs'),{COMPANY,BRANCH}=require('./helpers/integrationsDb')
const ids=['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'],context={companyId:COMPANY,scopes:['availability.read'],branches:[{id:BRANCH}],servicesEnabled:true}
test('availability preserves exact large strings and refuses numbers whose precision is already lost',async()=>{
 let batches=0
 await withMocks({[require.resolve('../src/services/bomStock')]:{getAvailabilityBatchWithKits:async()=>{batches++;return{[ids[0]]:{available:'9007199254740993.125',reserved:'PRIVATE'},[ids[1]]:{available:9007199254740992}}}}},require.resolve('../src/modules/integrations/catalog'),async({getAvailability})=>{
  const db={product:{findMany:async()=>ids.map(id=>({id,company_id:COMPANY,kind:'STANDARD',quantity_decimals:3}))}},out=await getAvailability(db,context,{productIds:ids.join(','),branchId:BRANCH})
  assert.equal(batches,1);assert.equal(out.items[0].quantity,'9007199254740993.125');assert.equal(out.items[1].quantity,null);assert.equal(out.items[1].status,'UNAVAILABLE');assert.doesNotMatch(JSON.stringify(out),/PRIVATE|reserved/)
 })
})
test('an invalid kit component never reaches the stock engine or leaks another company inventory',async()=>{
 await withMocks({[require.resolve('../src/services/bomStock')]:{getAvailabilityBatchWithKits:async()=>{throw Error('Must not query foreign components')}}},require.resolve('../src/modules/integrations/catalog'),async({getAvailability})=>{
  const db={product:{findMany:async()=>[{id:ids[0],company_id:COMPANY,kind:'KIT',kit_components:[{component_product:{company_id:'foreign',deleted:false}}]}]}},out=await getAvailability(db,context,{productIds:ids[0],branchId:BRANCH})
  assert.equal(out.items[0].quantity,null);assert.equal(out.items[0].status,'UNAVAILABLE')
 })
})
