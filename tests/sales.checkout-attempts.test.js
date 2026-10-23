const test=require('node:test'),assert=require('node:assert/strict')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const path=require('node:path'),fs=require('node:fs')
const target=path.resolve(__dirname,'../src/modules/sales/checkoutAttempts.js')
const api=()=>fs.existsSync(target)?require(target):{}
const scope={companyId:'A',branchId:'B',user:{sub:'U'}}
test('expected missing attempt responds directly, while database failures reach the error handler',async()=>{
 const model=require.resolve('../src/models/prisma'),controller=require.resolve('../src/modules/sales/controller')
 let failure=null
 await withMocks({[model]:{prisma:{sale:{findFirst:async()=>{if(failure)throw failure;return null}}}}},controller,async sales=>{
  const res=jsonResponse();let next
  await sales.checkoutAttempt({...scope,params:{key:'attempt'}},res,error=>{next=error})
  assert.equal(res.statusCode,404);assert.equal(res.body.code,'CHECKOUT_NOT_OBSERVED');assert.equal(next,undefined)
  failure=Object.assign(Error('db offline'),{code:'P1001'})
  await sales.checkoutAttempt({...scope,params:{key:'attempt'}},jsonResponse(),error=>{next=error})
  assert.equal(next,failure)
 })
})
test('checkout hash binds money, lines and origin, not object order or decimal formatting',()=>{
 const {checkoutHash}=api();assert.equal(typeof checkoutHash,'function')
 const a={items:[{product_id:'P',qty:'1.50',price:'2.00'}],payment_method_id:1}
 assert.equal(checkoutHash('SALE',a),checkoutHash('SALE',{payment_method_id:1,items:[{price:2,qty:1.5,product_id:'P'}]}))
 assert.notEqual(checkoutHash('SALE',a),checkoutHash('SALE',{...a,amount_received:100}))
 assert.notEqual(checkoutHash('SALE',a),checkoutHash('ORDER',a,'O'))
})
test('replay validates actor hash and legacy state before exposing a previous sale',()=>{
 const {assertCheckoutReplay,checkoutHash}=api();assert.equal(typeof assertCheckoutReplay,'function')
 const hash=checkoutHash('SALE',{items:[]}),sale={id:'V',created_by:'U',idempotency_hash:hash}
 assert.equal(assertCheckoutReplay(sale,scope,hash),sale)
 assert.throws(()=>assertCheckoutReplay({...sale,created_by:'OTHER'},scope,hash),e=>e.status===409)
 assert.throws(()=>assertCheckoutReplay(sale,scope,'different'),e=>e.status===409)
 assert.throws(()=>assertCheckoutReplay({...sale,idempotency_hash:null},scope,hash),e=>e.code==='LEGACY_ATTEMPT_REQUIRES_RECOVERY')
})
test('attempt lookup scopes actor company and branch and reports not-observed without making a sale',async()=>{
 const {lookupCheckoutAttempt}=api();assert.equal(typeof lookupCheckoutAttempt,'function')
 const db={sale:{findFirst:async({where})=>{assert.equal(where.branch_id,'B');assert.equal(where.created_by,'U');assert.equal(where.branch.company_id,'A');return null}}}
 await assert.rejects(lookupCheckoutAttempt(db,scope,'attempt'),e=>e.status===404&&e.code==='CHECKOUT_NOT_OBSERVED')
 db.sale.findFirst=async()=>({id:'V',orderLink:{document_id:'O'}})
 assert.deepEqual(await lookupCheckoutAttempt(db,scope,'attempt'),{state:'CONFIRMED',saleId:'V',kind:'ORDER',orderId:'O'})
})
test('controller rejects changed payload and foreign actor rather than replaying their sale',async()=>{
 const model=require.resolve('../src/models/prisma'),controller=require.resolve('../src/modules/sales/controller')
 const stored={id:'V',created_by:'U',idempotency_hash:'wrong'}
 await withMocks({[model]:{prisma:{sale:{findFirst:async()=>stored}},prismaTransaction:{$transaction:()=>assert.fail('must not mutate')}}},controller,async sales=>{
  const req={...scope,body:{idempotency_key:'attempt',items:[{product_id:'P',qty:1}],payment_method_id:1}}
  let error;await sales.create(req,jsonResponse(),e=>{error=e});assert.equal(error?.status,409)
 })
})
