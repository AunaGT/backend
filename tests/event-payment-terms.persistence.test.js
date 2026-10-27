const test=require('node:test'),assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const {quoteHarness}=require('./helpers/packageQuoteHarness')
const {id}=require('./helpers/packageFixtures')
const {freezeEventPaymentTerms}=require('../src/services/eventPaymentTerms')
const terms=()=>({schemaVersion:1,depositPercent:'25',balanceDaysBefore:3,referenceStartsAt:'2026-12-10T16:00:00Z',referenceTimezone:'America/Guatemala'})
test('quote freezes optional terms against server total and currency and preserves them on older edits',async()=>quoteHarness(async f=>{
 f.state.products.find(p=>p.id===id(20)).price='100.00'
 const created=await f.invoke('create',{items:[{product_id:id(20),qty:'1'}],eventPaymentTerms:terms()})
 assert.equal(created.error,undefined)
 const original=structuredClone(f.document().event_payment_terms)
 assert.equal(original.depositPercent,'25.00');assert.equal(original.basisTotal,'100.00');assert.equal(original.currencyCode,'GTQ')
 const revision=f.document().integration_revision
 const updated=await f.invoke('update',{items:[{product_id:id(20),qty:'2'}],expectedRevision:revision})
 assert.equal(updated.error,undefined)
 assert.equal(f.document().event_payment_terms.basisTotal,'200.00')
 assert.equal(f.document().event_payment_terms.depositPercent,'25.00')
 assert.equal(Number(created.res.body.total),100);assert.equal(original.basisTotal,'100.00')
}))
test('changing only the event condition requires the document revision and never removes its lines',async()=>quoteHarness(async f=>{
 await f.invoke('create',{items:[{product_id:id(20),qty:'1'}]})
 const lines=structuredClone(f.document().lines),revision=f.document().integration_revision
 const stale=await f.invoke('update',{eventPaymentTerms:terms(),expectedRevision:id(900)})
 assert.equal(stale.error?.code,'DOCUMENT_CHANGED');assert.equal(f.document().event_payment_terms,undefined)
 const saved=await f.invoke('update',{eventPaymentTerms:terms(),expectedRevision:revision})
 assert.equal(saved.error,undefined);assert.deepEqual(f.document().lines,lines)
 assert.equal(f.document().event_payment_terms.depositPercent,'25.00')
 const cleared=await f.invoke('update',{eventPaymentTerms:null,expectedRevision:f.document().integration_revision})
 assert.equal(cleared.error,undefined)
 assert.ok(f.document().event_payment_terms===null||f.document().event_payment_terms?.$type==='DbNull'||!f.document().event_payment_terms?.schemaVersion)
 assert.deepEqual(f.document().lines,lines)
}))
test('clients cannot inject calculated values or apply event terms to goods only or an accepted quote',async()=>quoteHarness(async f=>{
 for(const payload of [{...terms(),basisTotal:'0.01'},{...terms(),currencyCode:'USD'}]){
  const out=await f.invoke('create',{items:[{product_id:id(20),qty:'1'}],eventPaymentTerms:payload})
  assert.equal(out.error?.status,400)
 }
 const goods=await f.invoke('create',{items:[{product_id:id(21),qty:'1'}],eventPaymentTerms:terms()})
 assert.equal(goods.error?.code,'EVENT_TERMS_REQUIRE_SERVICE')
 await f.invoke('create',{items:[{product_id:id(20),qty:'1'}],eventPaymentTerms:terms()})
 const original=structuredClone(f.document());f.document().status='ACCEPTED'
 const changed=await f.invoke('update',{eventPaymentTerms:null,expectedRevision:f.document().integration_revision})
 assert.equal(changed.res.statusCode,400);assert.deepEqual(f.document().event_payment_terms,original.event_payment_terms)
}))
test('old client and missing DB columns cannot enable new conditions, while legacy writes remain usable',async()=>{
 const {eventPaymentStorageReady,prepareEventPaymentTermsWrite}=require('../src/services/eventPaymentTermsStorage')
 const models=Object.fromEntries(['CommercialDocument','Sale','AppointmentEngagement'].map(name=>[name,{fields:[{name:'event_payment_terms'},...(name==='AppointmentEngagement'?[{name:'event_payment_reference'}]:[])]}]))
 const old={_runtimeDataModel:{models:{}}}
 assert.equal(await eventPaymentStorageReady(old),false)
 const missing={_runtimeDataModel:{models},$queryRaw:async()=>[{total:0}]}
 assert.equal(await eventPaymentStorageReady(missing),false)
 const ready={_runtimeDataModel:{models},$queryRaw:async()=>[{total:4}]}
 assert.equal(await eventPaymentStorageReady(ready),true)
 assert.deepEqual(await prepareEventPaymentTermsWrite(old,{companyId:id(200)},{raw:undefined,total:'10',hasServices:true}),{})
 await assert.rejects(()=>prepareEventPaymentTermsWrite(missing,{companyId:id(200)},{raw:terms(),total:'10',hasServices:true}),{code:'EVENT_PAYMENT_TERMS_NOT_READY'})
})
test('conversion copies a validated detached snapshot and source changes are not silently accepted',()=>{
 const {copyEventPaymentTerms,assertEventPaymentAgreement}=require('../src/services/eventPaymentTermsStorage')
 const original=freezeEventPaymentTerms(terms(),{total:'99.99',currencyCode:'GTQ'})
 const row={event_payment_terms:original,total:new Prisma.Decimal('99.99')}
 const copy=copyEventPaymentTerms(row)
 assert.deepEqual(copy,{event_payment_terms:original});copy.event_payment_terms.depositPercent='0.00'
 assert.equal(row.event_payment_terms.depositPercent,'25.00')
 assertEventPaymentAgreement(row)
 assert.throws(()=>assertEventPaymentAgreement({...row,total:new Prisma.Decimal('100')}),{code:'EVENT_PAYMENT_TERMS_REVIEW_REQUIRED'})
})
test('direct engagement can choose conditions but quote-based creation cannot replace the agreed condition',()=>{
 const {parseEngagement}=require('../src/modules/appointments/engagements')
 const direct=parseEngagement({contactId:id(301),lines:[{productId:id(20),quantity:'1'}],idempotencyKey:'direct-policy-01',eventPaymentTerms:terms()})
 assert.equal(direct.eventPaymentTerms.depositPercent,'25.00')
 assert.throws(()=>parseEngagement({quoteId:id(400),idempotencyKey:'quoted-policy-01',eventPaymentTerms:terms()}),{code:'INVALID_INPUT'})
})
