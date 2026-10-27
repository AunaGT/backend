const test=require('node:test'),assert=require('node:assert/strict')
const {freezeEventPaymentTerms,publicEventPaymentTerms}=require('../src/services/eventPaymentTerms')
test('customer page terms are a detached bounded projection of the accepted agreement, not the collection ledger',()=>{
 const snapshot=freezeEventPaymentTerms({schemaVersion:1,depositPercent:'33.33',balanceDaysBefore:0,referenceStartsAt:'2027-01-10T16:00:00Z',referenceTimezone:'America/Guatemala'},{total:'100.01',currencyCode:'GTQ'})
 const safe=publicEventPaymentTerms(snapshot)
 assert.deepEqual(safe,{depositPercent:'33.33',depositRequired:'33.33',balanceDaysBefore:0,referenceStartsAt:'2027-01-10T16:00:00.000Z',referenceTimezone:'America/Guatemala',dueAt:'2027-01-10T16:00:00.000Z',currencyCode:'GTQ'})
 safe.depositPercent='0';assert.equal(snapshot.depositPercent,'33.33');assert.equal(publicEventPaymentTerms(null),null)
})
