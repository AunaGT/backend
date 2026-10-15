const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const {listPaymentMethodsCatalog,usageInclude}=require('../src/services/paymentMethods/management')
test('admin counts all filtered company preferences not only page',async()=>{
  const rows=[{enabled:true,payment_method:{is_credit:false}},{enabled:false,payment_method:{is_credit:true}}]
  const db={companyPaymentMethod:{count:async({where})=>{assert.equal(where.company_id,'A');return 2},
    findMany:async args=>args.take?[]:rows}}
  const result=await listPaymentMethodsCatalog(db,'A',{page:99,pageSize:1,includeSummary:true})
  assert.deepEqual(result.summary,{total:2,active:1,inactive:1,immediate:1,credit:1})
  assert.equal(result.page,2);assert.equal(result.prevPage,1);assert.equal(result.nextPage,null)
  const counts=usageInclude('A')._count.select
  assert.deepEqual(counts.sales.where,{branch:{company_id:'A'}})
  assert.deepEqual(counts.customer_payments.where,{branch:{company_id:'A'}})
  assert.deepEqual(counts.supplier_payments.where,{company_id:'A'})
  assert.deepEqual(counts.cash_closure_payments.where,{cash_closure:{branch:{company_id:'A'}}})
  assert.deepEqual(counts.return_settlements.where,{return:{sale:{branch:{company_id:'A'}}}})
  assert.deepEqual(counts.customer_payment_refunds.where,{company_id:'A'})
})
test('GET empty configuration does not initialize global methods',async()=>{
  const target=require.resolve('../src/modules/catalogs/paymentMethods.controller')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{companyPaymentMethod:{findMany:async()=>[],count:async()=>0}}}},target,async ctrl=>{
    let error;await ctrl.list({companyId:'A',query:{}},jsonResponse(),e=>{error=e})
    assert.equal(error?.code,'PM_SETUP_REQUIRED')
  })
})
