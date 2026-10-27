const test=require('node:test'),assert=require('node:assert/strict')
const {id}=require('./helpers/packageFixtures')
const {freezeEventPaymentTerms}=require('../src/services/eventPaymentTerms')
const {paymentReferencePlan:plan,reviewEngagementPaymentReferences:review}=require('../src/modules/appointments/engagementPaymentReference')
function agreement(){return {id:id(1),company_id:id(200),branch_id:id(201),customer_id:id(301),version:1,quote_id:null,sale_id:null,currency_code:'GTQ',agreed_total:'100.00',commercial_snapshot:{},event_payment_reference:null,
 event_payment_terms:freezeEventPaymentTerms({schemaVersion:1,depositPercent:'25',balanceDaysBefore:2,referenceStartsAt:'2027-01-10T16:00:00Z',referenceTimezone:'America/Guatemala'},{total:'100',currencyCode:'GTQ'}),
 lines:[{id:id(2),item_kind:'SERVICE',qty:'2',quantity_decimals:0,schedules:[]}]}}
const schedule=(n,start,patch={})=>({id:id(n),session_id:id(n+10),quantity:'1',kind:'ACTIVITY',state:'COMMITTED',session:{id:id(n+10),starts_at:new Date(start),ends_at:new Date(Date.parse(start)+3600000),timezone:'America/Guatemala',status:'SCHEDULED'},booking:null,...patch})
test('partial schedules never silently postpone the agreed reference, complete schedules use their real first service',()=>{
 const e=agreement();e.lines[0].schedules=[schedule(3,'2027-01-12T16:00:00Z')]
 assert.equal(plan(e).after.startsAt,'2027-01-10T16:00:00.000Z');assert.equal(plan(e).changed,false)
 e.lines[0].schedules.push(schedule(4,'2027-01-13T16:00:00Z'))
 const full=plan(e);assert.equal(full.after.startsAt,'2027-01-12T16:00:00.000Z');assert.equal(full.changed,true);assert.equal(full.dueAfter,'2027-01-10T16:00:00.000Z')
 e.lines[0].schedules[1].session.starts_at=new Date('2027-01-08T16:00:00Z')
 assert.equal(plan(e).dueAfter,'2027-01-06T16:00:00.000Z')
})
test('cancelling or releasing the first schedule cannot silently extend the deadline',()=>{
 const e=agreement();e.event_payment_reference={startsAt:'2027-01-07T16:00:00.000Z',timezone:'America/Guatemala'}
 e.lines[0].schedules=[schedule(3,'2027-01-07T16:00:00Z',{state:'CANCELLED'}),schedule(4,'2027-01-12T16:00:00Z')]
 assert.equal(plan(e).after.startsAt,'2027-01-07T16:00:00.000Z');assert.equal(plan(e).reviewRequired,true)
 e.lines[0].schedules[0].state='RELEASED'
 assert.equal(plan(e).after.startsAt,'2027-01-07T16:00:00.000Z');assert.equal(plan(e).reviewRequired,true)
})
test('review is retryable after tentative inserts are rolled back and rejects stale context before persisting',async()=>{
 const e=agreement();e.lines[0].schedules=[schedule(3,'2027-01-08T16:00:00Z')]
 const scope={companyId:e.company_id,branchId:e.branch_id,userId:id(202),permissions:['appointments.view','appointments.edit'],isAdmin:false}
 const history=[],writes=[]
 const db={appointmentEngagement:{findFirst:async()=>structuredClone(e),update:async q=>{writes.push(q);return q.data}},
  appointmentEngagementHistory:{create:async q=>{history.push(q.data);return q.data}},$executeRaw:async()=>0,$queryRaw:async()=>[],
  paymentCommitment:{aggregate:async()=>({_sum:{amount:'25.00'}})},customerPaymentRefund:{aggregate:async()=>({_sum:{amount:'0.00'}})},paymentAllocationEvent:{aggregate:async()=>({_sum:{amount:'0.00'}})}}
 let conflict
 try{await review(db,scope,{engagementIds:[e.id],now:new Date('2026-12-01T00:00:00Z')})}catch(error){conflict=error}
 assert.equal(conflict?.code,'PAYMENT_REFERENCE_REVIEW_REQUIRED');assert.equal(writes.length,0)
 const hash=conflict.fields.acknowledgedPaymentReviewHash
 e.lines[0].schedules[0].id=id(999);e.lines[0].schedules[0].session_id=id(998);e.lines[0].schedules[0].session.id=id(998)
 await review(db,scope,{engagementIds:[e.id],acknowledgedPaymentReviewHash:hash,now:new Date('2026-12-01T00:00:00Z')})
 assert.equal(writes.length,1);assert.equal(writes[0].data.event_payment_reference.startsAt,'2027-01-08T16:00:00.000Z');assert.equal(history.length,1)
 e.version++
 await assert.rejects(()=>review(db,scope,{engagementIds:[e.id],acknowledgedPaymentReviewHash:hash,now:new Date()}),{code:'PAYMENT_REFERENCE_REVIEW_REQUIRED'})
 assert.equal(writes.length,1)
})
