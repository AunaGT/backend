const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {toCents,fromCents}=require('../src/modules/merchandise/payables/money')
const {balanceOf,planApplications}=require('../src/modules/merchandise/payables/balance')
const v=require('../src/modules/merchandise/payables/validation')
const row={source:'PURCHASE',payment_status:'PENDING',payment_revision:0,payment_balance_review_required:false,legacy_settled_amount:'0.00',items:[{quantity:1,unit_cost:'100.00'}],paymentEntries:[]}
test('PAID is not evidence of historical settlement after migration',()=>{
  assert.equal(balanceOf({...row,payment_status:'PAID'}).balance,'100.00')
  assert.equal(balanceOf({...row,legacy_settled_amount:'100.00'}).balance,'0.00')
  assert.equal(balanceOf({...row,legacy_settled_amount:'80.00',paymentEntries:[{amount:'20.00'}]}).status,'PAID')
})
test('initial stock and unresolved historic records cannot become invented payable amounts',()=>{
  assert.equal(balanceOf({...row,source:'INITIAL'}).excluded,true)
  assert.equal(balanceOf({...row,payment_balance_review_required:true}).balance,null)
  assert.equal(balanceOf({...row,paymentEntries:[{amount:'101.00'}]}).status,'REVIEW')
})
test('only active applications affect balance; historical cost not product current cost',()=>{
  const result=balanceOf({...row,items:[{quantity:2,unit_cost:'50.00',product:{cost:999}}],paymentEntries:[{amount:'10.20'},{amount:'89.80',cancelled_at:new Date()}]})
  assert.equal(result.total,'100.00');assert.equal(result.documentedPaid,'10.20');assert.equal(result.balance,'89.80');assert.equal(result.status,'PARTIAL')
})
test('money rejects noncanonical and unsafe amounts instead of rounding',()=>{
  assert.equal(toCents('0.10')+toCents('0.20'),30);assert.equal(fromCents(30),'0.30')
  for(const raw of ['1.001','1,25','NaN','Infinity','1e3','-1','',null,{},'9007199254740992'])assert.throws(()=>toCents(raw),String(raw))
  assert.throws(()=>fromCents(Number.MAX_SAFE_INTEGER+1))
})
test('applications require exact sum, positive unique amounts and current revisions',()=>{
  const entries=[{id:'a',balance:'60.00',revision:0},{id:'b',balance:'40.00',revision:0}],input={amount:'100.00',applications:[{incomingId:'a',amount:'60.00',expectedRevision:0},{incomingId:'b',amount:'40.00',expectedRevision:0}]}
  assert.deepEqual(planApplications(entries,input),[{incomingId:'a',amount:'60.00'},{incomingId:'b',amount:'40.00'}])
  for(const apps of [[{incomingId:'a',amount:'60.01',expectedRevision:0},{incomingId:'b',amount:'39.99',expectedRevision:0}],[input.applications[0]],[input.applications[0],input.applications[0]],[{incomingId:'a',amount:'0.00',expectedRevision:0}],[{...input.applications[0],expectedRevision:2},input.applications[1]]])assert.throws(()=>planApplications(entries,{...input,applications:apps}))
  assert.throws(()=>planApplications([{id:'a',balance:null,revision:0}],{amount:'1.00',applications:[{incomingId:'a',amount:'1.00',expectedRevision:0}]}))
})
test('payment trust boundary rejects extra keys, fake identities, precision, dates and unsupported counts',()=>{
  const raw={requestKey:crypto.randomUUID(),supplierId:crypto.randomUUID(),amount:'1.00',currencyCode:'GTQ',paidAt:'2026-10-14T12:00:00-06:00',paymentMethodId:1,reference:null,notes:null,applications:[{incomingId:crypto.randomUUID(),amount:'1.00',expectedRevision:0}]}
  assert.equal(v.parseSupplierPayment(raw).amount,'1.00')
  for(const patch of [{companyId:crypto.randomUUID()},{amount:'1.001'},{paidAt:'2026-02-30T12:00:00Z'},{paymentMethodId:null},{applications:[]},{applications:Array(101).fill(raw.applications[0])},{applications:[{...raw.applications[0],cost:0}]},{notes:'x'.repeat(2001)}])assert.throws(()=>v.parseSupplierPayment({...raw,...patch}))
  assert.equal(v.parseSupplierPayment({...raw,paymentMethodId:null},{allowMissingMethod:true}).paymentMethodId,null)
  assert.throws(()=>v.parseCancellation({reason:''}));assert.equal(v.parseHistoricalCorrection({amount:'0.00',expectedRevision:0,reason:'Confirmado sin pagos'}).amount,'0.00')
})
test('query filters reject invalid ranges and derive today from company zone',()=>{
  assert.equal(v.parsePayableFilters({},'America/Guatemala',new Date('2026-10-15T03:00:00Z')).localDay,'2026-10-14')
  assert.throws(()=>v.parsePayableFilters({dateFrom:'2026-10-15',dateTo:'2026-10-14'},'America/Guatemala'))
  assert.throws(()=>v.parsePayableFilters({asOf:'2020-01-01'},'America/Guatemala'))
  assert.throws(()=>v.parsePayableFilters({supplierId:'not-a-uuid'},'America/Guatemala'))
})
