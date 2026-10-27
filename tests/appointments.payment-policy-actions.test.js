const test=require('node:test'),assert=require('node:assert/strict'),{Prisma}=require('@prisma/client')
const {id}=require('./helpers/packageFixtures')
const {freezeEventPaymentTerms}=require('../src/services/eventPaymentTerms')
const {assertEngagementPaymentAction:guard,parsePaymentException:parse}=require('../src/modules/appointments/engagementPaymentPolicy')
function fixture(){
 const scope={companyId:id(200),branchId:id(201),branchIds:[id(201)],userId:id(202),permissions:['appointments.view','appointments.attend'],isAdmin:false}
 const e={id:id(1),company_id:scope.companyId,branch_id:scope.branchId,customer_id:id(301),version:1,quote_id:null,sale_id:null,currency_code:'GTQ',agreed_total:new Prisma.Decimal('100'),commercial_snapshot:{},resolution_pending:false,refunds:[],
  event_payment_terms:freezeEventPaymentTerms({schemaVersion:1,depositPercent:'25',balanceDaysBefore:2,referenceStartsAt:'2026-12-10T16:00:00Z',referenceTimezone:'America/Guatemala'},{total:'100',currencyCode:'GTQ'}),
  lines:[{id:id(2),item_kind:'SERVICE',qty:'1',quantity_decimals:0,schedules:[{id:id(3),kind:'ACTIVITY',state:'COMPLETED',quantity:'1',session_id:id(4),session:{status:'COMPLETED',starts_at:new Date('2026-12-10T16:00:00Z'),ends_at:new Date('2026-12-10T17:00:00Z')}}]}]}
 const state={paid:'25.00'},history=[]
 const db={appointmentEngagementSchedule:{findMany:async({where})=>where.OR?.some(q=>q.booking_id===id(999))?[]:[{kind:'ACTIVITY',engagement_id:e.id,line:{engagement:e}}]},
  appointmentEngagement:{findFirst:async()=>e},appointmentEngagementHistory:{create:async({data})=>{history.push(data);return data}},$queryRaw:async()=>[], $executeRaw:async()=>0,
  paymentCommitment:{aggregate:async()=>({_sum:{amount:state.paid}})},paymentAllocationEvent:{aggregate:async()=>({_sum:{amount:'0.00'}})},customerPaymentRefund:{aggregate:async()=>({_sum:{amount:'0.00'}})},systemSetting:{findUnique:async()=>({value:'GTQ'})}}
 const run=(patch={})=>guard(db,scope,{sessionId:id(4),action:'START',now:new Date('2026-12-09T00:00:00Z'),idempotencyKey:'synthetic-start-01',...patch})
 return {scope,e,state,db,history,run}
}
test('an overdue action needs an explicitly allowed exception, never a client paid flag',async()=>{
 const f=fixture()
 await assert.rejects(()=>f.run(),error=>error.code==='EVENT_PAYMENT_CONDITIONS_REQUIRED'&&error.fields.paymentPolicyCanOverride==='false')
 f.scope.permissions.push('appointments.override_payment_policy','receivables.view')
 let error;try{await f.run()}catch(e){error=e}
 assert.equal(error.fields.paymentPolicyCanOverride,'true')
 const exception={reason:'Crédito autorizado para esta atención',reviewHash:error.fields.paymentPolicyReviewHash}
 await f.run({exception})
 assert.equal(f.history.length,1);assert.equal(f.history[0].action,'PAYMENT_POLICY_EXCEPTION');assert.equal(f.state.paid,'25.00')
 await assert.rejects(()=>f.run({action:'COMPLETE',exception}),{code:'PAYMENT_POLICY_REVIEW_CHANGED'})
 f.state.paid='30.00'
 await assert.rejects(()=>f.run({exception}),{code:'PAYMENT_POLICY_REVIEW_CHANGED'})
})
test('exceptions cannot bypass missing deposits, incomplete scheduling or revoked permissions',async()=>{
 const f=fixture();f.scope.permissions.push('appointments.override_payment_policy','receivables.view');f.state.paid='0.00'
 await assert.rejects(()=>f.run(),error=>error.fields.paymentPolicyCanOverride==='false')
 f.state.paid='25.00';f.e.lines[0].qty='2'
 await assert.rejects(()=>f.run(),error=>error.fields.paymentPolicyCanOverride==='false')
 f.e.lines[0].qty='1'
 let error;try{await f.run()}catch(e){error=e}
 f.scope.permissions=f.scope.permissions.filter(p=>p!=='appointments.override_payment_policy')
 await assert.rejects(()=>f.run({exception:{reason:'Motivo',reviewHash:error.fields.paymentPolicyReviewHash}}),{status:403})
 assert.equal(f.history.length,0)
})
test('cancelling never returns funds and a different shared-class booking inherits no private debt',async()=>{
 const f=fixture();await f.run({action:'CANCEL'});await f.run({bookingId:id(999),action:'START'})
 assert.equal(f.history.length,0);assert.equal(f.state.paid,'25.00')
 f.state.paid='100.00';await f.run()
 f.e.event_payment_terms=null;await f.run()
})
test('exception payload is closed, bounded and supported only for service execution actions',()=>{
 assert.deepEqual(parse(undefined,'START'),{})
 assert.deepEqual(parse({reason:' Motivo ',reviewHash:'a'.repeat(64)},'START'),{exception:{reason:'Motivo',reviewHash:'a'.repeat(64)}})
 for(const raw of [{reason:'',reviewHash:'a'.repeat(64)},{reason:'x'.repeat(501),reviewHash:'a'.repeat(64)},{reason:'Motivo',reviewHash:'old'},{reason:'Motivo',reviewHash:'a'.repeat(64),paid:true}])assert.throws(()=>parse(raw,'START'),{code:'INVALID_INPUT'})
 assert.throws(()=>parse({reason:'Motivo',reviewHash:'a'.repeat(64)},'CANCEL'),{code:'INVALID_INPUT'})
})
