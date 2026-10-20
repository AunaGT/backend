const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('converted order can replay before checking its fulfilled status',async()=>{
 const db={sale:{findFirst:async()=>({id:'V',created_by:'U',idempotency_hash:'hash',orderLink:{document_id:'O'}})},commercialDocument:{findFirst:()=>assert.fail('replay must not check fulfilled order')}}
 const helper=require.resolve('../src/modules/sales/checkoutAttempts')
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db},[helper]:{checkoutKey:()=> 'attempt',checkoutHash:()=> 'hash',assertCheckoutReplay:s=>s,lockCheckoutAttempt:async()=>{}}},require.resolve('../src/modules/orders/controller'),async orders=>{
  const response=jsonResponse();await orders.convertToSale({companyId:'A',branchId:'B',user:{sub:'U'},params:{id:'O'},body:{payment_method_id:1,idempotency_key:'attempt'}},response,e=>{throw e})
  assert.equal(response.body.sale.id,'V');assert.equal(response.statusCode,200)
 })
})
