const test=require('node:test'),assert=require('node:assert/strict')
const {unappliedPayments,availableCredit,applyAvailableCredit,checkCredit}=require('../src/modules/receivables')
const payment={id:'receipt',amount:'100.00',applications:[{amount:'30.00'}],commitments:[{amount:'60.00',state:'COMMITTED'}],refunds:[{amount:'5.00',status:'CONFIRMED'}]}
test('all credit consumers count applied, committed and refunded money only once',async()=>{
  const writes=[]
  const db={$executeRaw:async()=>{},customerPayment:{findMany:async()=>[payment]},sale:{findMany:async()=>[{id:'sale',adjusted_total:'90.00',paymentEntries:[],due_date:null}]},salePaymentEntry:{create:async({data})=>writes.push(data)}}
  const rows=await unappliedPayments(db,'customer',{branch_id:'branch'})
  assert.equal(rows[0].unapplied,5)
  assert.equal(await availableCredit(db,'customer',{branch_id:'branch'}),5)
  const credit=await checkCredit(db,{id:'customer',credit_limit:90},10,{branch_id:'branch'})
  assert.equal(credit.ok,false);assert.equal(credit.credito_disponible,5)
})
test('new financial allocation rejects a receipt whose existing destinations exceed its amount',async()=>{
  const db={customerPayment:{findMany:async()=>[{...payment,commitments:[{amount:'66.00',state:'COMMITTED'}]}]}}
  await assert.rejects(()=>availableCredit(db,'customer'),{code:'PAYMENT_ALLOCATION_CONFLICT'})
})
test('a sale refund cannot become free credit again after reducing its original receipt application',async()=>{
  const db={customerPayment:{findMany:async()=>[{id:'receipt',amount:'100.00',applications:[{amount:'70.00'}],commitments:[],refunds:[],allocation_events:[{action:'SALE_REFUNDED',amount:'30.00'}]}]}}
  assert.equal(await availableCredit(db,'customer'),0)
})
