const test=require('node:test'),assert=require('node:assert/strict')
const {Prisma}=require('@prisma/client')
const {id}=require('./helpers/packageFixtures')
const {freezeEventPaymentTerms}=require('../src/services/eventPaymentTerms')
const {loadEngagementPaymentState:load,paymentPolicyPublicState:present}=require('../src/modules/appointments/engagementPaymentPolicy')
function fixture(){
 const scope={companyId:id(200),branchId:id(201),branchIds:[id(201)],userId:id(202),permissions:['appointments.view','receivables.view'],isAdmin:false}
 const e={id:id(400),company_id:scope.companyId,branch_id:scope.branchId,customer_id:id(301),version:1,quote_id:null,sale_id:null,currency_code:'GTQ',agreed_total:new Prisma.Decimal('100.00'),commercial_snapshot:{},resolution_pending:false,refunds:[],
  event_payment_terms:freezeEventPaymentTerms({schemaVersion:1,depositPercent:'40',balanceDaysBefore:0,referenceStartsAt:'2027-01-01T16:00:00Z',referenceTimezone:'America/Guatemala'},{total:'100.00',currencyCode:'GTQ'}),
  lines:[{id:id(401),item_kind:'SERVICE',qty:'1',quantity_decimals:0,schedules:[]}]}
 const state={committed:'40.00',applied:'0.00',refunded:'0.00',total:'100.00'}
 const db={paymentCommitment:{aggregate:async({where})=>({_sum:{amount:where.engagement_id===e.id?state.committed:'90.00'}})},
  salePaymentEntry:{aggregate:async({where})=>({_sum:{amount:where.sale_id===e.sale_id?state.applied:'90.00'}})},
  customerPaymentRefund:{aggregate:async()=>({_sum:{amount:state.refunded}})},paymentAllocationEvent:{aggregate:async()=>({_sum:{amount:'0.00'}})},
  sale:{findUnique:async()=>({adjusted_total:state.total})},systemSetting:{findUnique:async()=>({value:'GTQ'})}}
 return {scope,e,state,db,read:()=>load(db,scope,e,{now:new Date('2026-11-01T00:00:00Z'),lockMoney:false})}
}
test('committed money becomes applied money without being counted twice',async()=>{
 const f=fixture(),first=await f.read()
 assert.equal(first.paid,'40.00');assert.equal(first.depositMissing,'0.00');assert.equal(first.remaining,'60.00')
 f.e.sale_id=id(410);f.state.committed='0.00';f.state.applied='40.00'
 const applied=await f.read()
 assert.equal(applied.paid,'40.00');assert.equal(applied.remaining,'60.00');assert.equal(applied.depositMissing,'0.00')
 assert.equal(applied.confirmation,'PENDING_SCHEDULE','paying alone must not confirm the service')
})
test('released or refunded allocations reduce coverage once, and pending requests require review without simulating a refund',async()=>{
 const f=fixture(),before=await f.read()
 f.state.committed='30.00';f.state.refunded='10.00'
 const refunded=await f.read()
 assert.equal(refunded.paid,'30.00');assert.equal(refunded.depositMissing,'10.00');assert.equal(refunded.remaining,'70.00')
 assert.notEqual(refunded.reviewHash,before.reviewHash)
 f.e.refunds=[{id:id(420),status:'REQUESTED',amount:'10.00'}]
 const pending=await f.read()
 assert.equal(pending.paid,'30.00');assert.equal(pending.confirmation,'REVIEW_REQUIRED')
})
test('free credit and funds of another agreement do not cover this deposit; changed sale total requires review',async()=>{
 const f=fixture();f.state.committed='0.00'
 const unpaid=await f.read()
 assert.equal(unpaid.paid,'0.00');assert.equal(unpaid.depositMissing,'40.00')
 f.e.sale_id=id(410);f.state.total='90.00'
 assert.equal((await f.read()).confirmation,'REVIEW_REQUIRED')
})
test('operational users receive only redacted capabilities, not amounts, receipts or financial hashes',async()=>{
 const state=await fixture().read()
 const safe=present(state,{financial:false})
 assert.equal(safe.confirmation,'PENDING_SCHEDULE');assert.equal(safe.canStart,false)
 for(const key of ['paid','remaining','depositRequired','depositMissing','reviewHash'])assert.equal(Object.hasOwn(safe,key),false)
 assert.deepEqual(present(state,{financial:true}),state)
 safe.reasons.push('changed');assert.ok(!state.reasons.includes('changed'))
})
test('legacy conditions need no extra financial or scheduling queries and scope mismatch is never exposed',async()=>{
 const f=fixture();f.e.event_payment_terms=null
 assert.equal((await load({},f.scope,f.e,{now:new Date()})).enabled,false)
 const other=fixture()
 await assert.rejects(()=>load(other.db,{...other.scope,companyId:id(999)},other.e,{now:new Date()}),{status:404,code:'NOT_FOUND'})
})
