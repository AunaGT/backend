const test=require('node:test'),assert=require('node:assert/strict')
const {parseEventPaymentTerms:parse,freezeEventPaymentTerms:freeze,eventPaymentDueAt:due,evaluateEventPaymentTerms:evaluate}=require('../src/services/eventPaymentTerms')
const input=(patch={})=>({schemaVersion:1,depositPercent:'33.33',balanceDaysBefore:2,referenceStartsAt:'2026-11-20T18:00:00-06:00',referenceTimezone:'America/Guatemala',...patch})
const terms=(patch={},total='100.01')=>freeze(input(patch),{total,currencyCode:'GTQ'})
const state=(patch={})=>evaluate({terms:terms(),reference:null,money:{total:'100.01',committed:'33.32',applied:'0.00',refunded:'0.00',remaining:'66.69'},scheduling:{complete:true,valid:true},reviewRequired:false,now:new Date('2026-11-01T00:00:00Z'),...patch})
test('percentage uses exact money and one missing cent prevents confirmation',()=>{
 const result=state()
 assert.equal(result.depositRequired,'33.33');assert.equal(result.depositMissing,'0.01')
 assert.equal(result.confirmation,'PENDING_DEPOSIT');assert.equal(result.canStart,false)
 const covered=state({money:{total:'100.01',committed:'0.00',applied:'33.33',remaining:'66.68'}})
 assert.equal(covered.paid,'33.33');assert.equal(covered.depositMissing,'0.00');assert.equal(covered.confirmation,'CONFIRMED')
 assert.equal(state({scheduling:{complete:false,valid:true},money:{total:'100.01',committed:'33.33',applied:'0.00',remaining:'66.68'}}).confirmation,'PENDING_SCHEDULE')
})
test('legacy and explicit zero do not introduce a deposit or a default date',()=>{
 assert.equal(parse(null),null);assert.equal(freeze(null,{total:'100.00',currencyCode:'GTQ'}),null)
 const legacy=state({terms:null})
 assert.equal(legacy.enabled,false);assert.equal(legacy.dueAt,null);assert.equal(legacy.canStart,true);assert.equal(legacy.canComplete,true)
 assert.equal(state({terms:terms({depositPercent:'0'})}).depositRequired,'0.00')
 const free=state({terms:terms({depositPercent:'100'},'0'),money:{total:'0.00',committed:'0.00',applied:'0.00',remaining:'0.00'}})
 assert.equal(free.confirmation,'CONFIRMED');assert.equal(free.payment,'PAID')
 assert.equal(state({terms:terms({depositPercent:'100'})}).depositRequired,'100.01')
})
test('closed bounded terms reject injected calculated values, malformed numbers and invalid dates',()=>{
 for(const raw of [undefined,[],{},input({schemaVersion:2}),input({basisTotal:'1.00'}),input({currencyCode:'USD'}),input({script:'bad'}),
  ...['',null,33.33,NaN,'NaN','1e2','-1','100.01','0.001','99999999999999999999'].map(depositPercent=>input({depositPercent})),
  ...['2',-1,366,1.5,null,NaN].map(balanceDaysBefore=>input({balanceDaysBefore})),
  input({referenceStartsAt:'2026-11-20'}),input({referenceStartsAt:'2026-02-30T00:00:00Z'}),input({referenceStartsAt:'x'.repeat(2049)}),input({referenceTimezone:'Invalid/Nowhere'})]){
  assert.throws(()=>parse(raw),{status:400,code:'INVALID_INPUT'})
 }
 assert.deepEqual(parse(input({depositPercent:'01.50'})),{schemaVersion:1,depositPercent:'1.50',balanceDaysBefore:2,referenceStartsAt:'2026-11-21T00:00:00.000Z',referenceTimezone:'America/Guatemala'})
 assert.throws(()=>freeze(input(),{total:'1e2',currencyCode:'GTQ'}),{status:400})
 assert.throws(()=>freeze(input(),{total:'1.00',currencyCode:'gtq'}),{status:400})
 assert.throws(()=>freeze(input(),{total:'10000000000.00',currencyCode:'GTQ'}),{status:400})
})
test('calendar-day deadlines preserve local time across DST and midnight',()=>{
 assert.equal(due(terms({referenceStartsAt:'2026-03-09T10:00:00-04:00',referenceTimezone:'America/New_York'}),null),'2026-03-07T15:00:00.000Z')
 assert.equal(due(terms(),{startsAt:'2026-11-02T00:30:00+09:00',timezone:'Asia/Tokyo'}),'2026-10-30T15:30:00.000Z')
 assert.equal(due(terms({balanceDaysBefore:0}),null),'2026-11-21T00:00:00.000Z')
 assert.equal(due(null,null),null)
 assert.throws(()=>due(terms(),{startsAt:'2026-11-20',timezone:'UTC'}),{status:400})
})
test('balance becomes overdue exactly at the agreed instant, but a fully paid agreement never does',()=>{
 const partial={total:'100.01',committed:'33.33',applied:'0.00',remaining:'66.68'}
 assert.equal(state({money:partial,now:new Date('2026-11-19T00:00:00Z')}).payment,'OVERDUE')
 assert.equal(state({money:partial,now:new Date('2026-11-18T23:59:59.999Z')}).payment,'PARTIAL')
 const overdue=state({money:partial,now:new Date('2026-11-19T00:00:00Z')})
 assert.equal(overdue.canStart,false);assert.equal(overdue.canComplete,false);assert.ok(overdue.reasons.includes('BALANCE_OVERDUE'))
 const paid=state({money:{total:'100.01',committed:'0.00',applied:'100.01',remaining:'0.00'},now:new Date('2026-12-01T00:00:00Z')})
 assert.equal(paid.payment,'PAID');assert.equal(paid.canStart,true);assert.equal(paid.canComplete,true)
 assert.throws(()=>state({now:new Date('invalid')}),{status:400})
})
test('commercial and assignment review prevent confirmation even after enough money was received',()=>{
 const paid={total:'100.01',committed:'100.01',applied:'0.00',remaining:'0.00'}
 for(const patch of [{reviewRequired:true},{scheduling:{complete:true,valid:false}},{money:{...paid,total:'90.00'}}]){
  const out=state({money:paid,...patch})
  assert.equal(out.confirmation,'REVIEW_REQUIRED');assert.equal(out.canStart,false);assert.equal(out.canComplete,false)
 }
})
