const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const {Prisma}=require('@prisma/client')
test('legacy order conversion rejects disabled medium before a sale is written',async()=>{
  let writes=0
  const method={id:7,name:'Tarjeta',is_credit:false}
  const tx={$executeRaw:async()=>0,companyPaymentMethod:{findFirst:async()=>({enabled:false,payment_method:method})},paymentMethod:{findUnique:async()=>method},
    cashRegister:{findFirst:async()=>({id:'CR'})},cashRegisterSession:{findFirst:async()=>({id:'CS',opened_by_id:'U'})},sale:{create:async()=>{writes++}},
    commercialDocument:{findFirst:async()=>({id:'O',branch_id:'B',status:'CONFIRMED',fulfillment_mode:'LEGACY',lines:[{id:'L',product_id:'P',qty:1,qty_fulfilled:0,unit_price:10}]})}}
  tx.$transaction=async run=>run(tx)
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:tx}},require.resolve('../src/modules/orders/controller'),async ctrl=>{
    let error;await ctrl.convertToSale({companyId:'A',branchId:'B',params:{id:'O'},user:{sub:'U'},body:{payment_method_id:7,cash_register_id:'CR',lines:[{line_id:'L',qty:1}]}},jsonResponse(),e=>{error=e})
    assert.equal(error?.code,'PM_DISABLED');assert.equal(error?.status,409)
  });assert.equal(writes,0)
})
for(const purpose of ['receipt','refund'])test(`Agenda ${purpose} rejects disabled medium without writing money`,async()=>{
  const service=require('../src/modules/receivables/engagementPayments')
  let writes=0
  const e={id:'E',company_id:'A',branch_id:'B',customer_id:'C',currency_code:'GTQ',agreed_total:'100'}
  const scope={companyId:'A',branchId:'B',userId:'U'},input={amount:'10',currencyCode:'GTQ',paymentMethodId:7,paidAt:new Date().toISOString(),receiptId:'R',refundId:'F'}
  const tx={$executeRaw:async()=>0,companyPaymentMethod:{findFirst:async()=>({enabled:false,payment_method:{id:7,is_credit:false}})},paymentMethod:{findUnique:async()=>({id:7,is_credit:false,name:'Transferencia'})},
    supplier:{findFirst:async()=>({id:'C'})},systemSetting:{findUnique:async()=>({value:'GTQ'})},
    paymentCommitment:{aggregate:async()=>({_sum:{amount:'0'}}),findFirst:async()=>({amount:new Prisma.Decimal(10)})},
    paymentAllocationEvent:{aggregate:async()=>({_sum:{amount:'0'}})},
    customerPaymentRefund:{aggregate:async()=>({_sum:{amount:'0'}}),count:async()=>0,findFirst:async()=>({id:'F',status:'REQUESTED',amount:new Prisma.Decimal(10)}),update:async()=>{writes++}},
    customerPayment:{create:async()=>{writes++;return{id:'R'}}}}
  await assert.rejects(purpose==='receipt'?service.createScopedReceipt(tx,scope,e,input):service.confirmScopedRefund(tx,scope,e,input),error=>error.code==='PM_DISABLED')
  assert.equal(writes,0)
})
test('initial payment cannot apply money with disabled company method',async()=>{
  let writes=0
  const legacy={id:7,name:'Tarjeta',company_id:null,is_credit:false,settlement_kind:'BANK'}
  const tx={$executeRaw:async()=>0,paymentMethod:{findUnique:async()=>legacy},companyPaymentMethod:{findFirst:async()=>({enabled:false,payment_method:legacy})}}
  await withMocks({[require.resolve('../src/modules/receivables')]:{applyPayment:async()=>{writes++}}},require.resolve('../src/services/commercialPayment'),async s=>{
    await assert.rejects(s.recordInitialPayment(tx,{companyId:'A',user:{sub:'U'},body:{initial_payment:{payment_method_id:7}}},{id:'V',date:new Date(),branch_id:'B',customer_contact_id:'C'},10,'CS'),e=>e.code==='PM_DISABLED')
  });assert.equal(writes,0)
})
test('receivable controller resolves availability on money transaction, never outside',async()=>{
  let writes=0,inTx=false
  const method={id:7,name:'Tarjeta',company_id:null,is_credit:false}
  const tx={$executeRaw:async()=>0,companyPaymentMethod:{findFirst:async()=>{assert.equal(inTx,true);return{enabled:false,payment_method:method}}},customerPayment:{create:async()=>{writes++}}}
  const db={supplier:{findFirst:async()=>({id:'C'})},paymentMethod:{findUnique:async()=>method},$transaction:async run=>{inTx=true;try{return await run(tx)}finally{inTx=false}}}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/receivables/controller'),async ctrl=>{
    let error;await ctrl.createPayment({companyId:'A',branchId:'B',user:{sub:'U'},body:{amount:10,customer_id:'C',payment_method_id:7}},jsonResponse(),e=>{error=e})
    assert.equal(error?.code,'PM_DISABLED');assert.equal(error?.status,409)
  });assert.equal(writes,0)
})
