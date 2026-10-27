const test=require('node:test'),assert=require('node:assert/strict')
const {quoteHarness}=require('./helpers/packageQuoteHarness'),{id}=require('./helpers/packageFixtures')
const input={schemaVersion:1,depositPercent:'25',balanceDaysBefore:3,referenceStartsAt:'2027-01-10T16:00:00Z',referenceTimezone:'America/Guatemala'}
test('editor capability stays disabled with the previous generated client',async()=>quoteHarness(async f=>{
 f.db._runtimeDataModel={models:{}}
 const result=await f.invoke('paymentTermsCapability',{})
 assert.equal(result.error,undefined);assert.equal(result.res.body.enabled,false)
}))
test('shared proposal exposes agreed conditions but never payment allocations or operational exceptions',async()=>quoteHarness(async f=>{
 f.state.products.find(p=>p.id===id(20)).price='100.00'
 const created=await f.invoke('create',{items:[{product_id:id(20),qty:'1'}],eventPaymentTerms:input});assert.equal(created.error,undefined)
 Object.assign(f.document(),{status:'SENT',committed:'SECRET',history:[{reason:'PRIVATE_EXCEPTION'}]})
 f.document().lines.forEach(l=>{l.service_schedule_snapshot=null})
 f.db.systemSetting.findMany=async()=>[{key:'currency_code',value:'GTQ'}]
 const result=await f.invoke('getPublicByToken',{})
 assert.equal(result.error,undefined);assert.equal(result.res.body.eventPaymentTerms.depositRequired,'25.00')
 assert.equal(result.res.body.eventPaymentTerms.dueAt,'2027-01-07T16:00:00.000Z')
 assert.doesNotMatch(JSON.stringify(result.res.body),/SECRET|PRIVATE_EXCEPTION|committed|reviewHash/)
}))
test('public acceptance cannot bypass changed payment conditions and never receives money',async()=>quoteHarness(async f=>{
 await f.invoke('create',{items:[{product_id:id(20),qty:'1'}],eventPaymentTerms:input})
 Object.assign(f.document(),{status:'SENT',valid_until:new Date(Date.now()+86400000).toISOString(),public_token:'token'})
 const before=structuredClone(f.document().event_payment_terms)
 const result=await f.invoke('respondPublic',{status:'ACCEPTED'})
 assert.equal(result.error,undefined);assert.equal(f.document().status,'ACCEPTED');assert.deepEqual(f.document().event_payment_terms,before)
 assert.equal(f.stockWrites(),0)
}))
