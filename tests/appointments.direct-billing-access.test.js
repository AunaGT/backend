require('./setup-env')
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const id='11111111-1111-4111-8111-111111111111'
test('billing source routes are private and reject unexpected commercial inputs before writes',async()=>{
  const router=require('../src/modules/appointments/routes')
  assert.equal(router.stack[0].handle,require('../src/middlewares/autenticacion').Auth)
  for(const action of ['preview','prepare'])assert.ok(router.stack.find(l=>l.route?.path===`/billing-sources/:kind/:id/${action}`)?.route.methods.post)
  let writes=0
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{},prismaTransaction:{$transaction:async()=>{writes++}}}},path.resolve(__dirname,'../src/modules/appointments/controller.js'),async c=>{
    const base={companyId:'company',branchId:'branch',user:{sub:'user',role:'admin',permissions:['appointments.view']},params:{kind:'bookings',id},body:{}}
    let res=jsonResponse();await c.billingSourcePreview({...base,user:undefined},res,e=>{throw e});assert.equal(res.statusCode,401)
    for(const [kind,body] of [['sessions',{}],...['price','total','paid','saleId','contactId','quantity'].map(k=>['bookings',{[k]:'bad'}])]){
      res=jsonResponse();await c.billingSourcePreview({...base,params:{kind,id},body},res,e=>{throw e});assert.equal(res.statusCode,400)
    }
    res=jsonResponse();await c.prepareSourceBilling({...base,body:{}},res,e=>{throw e});assert.equal(res.statusCode,400)
    res=jsonResponse();await c.billingSourcePreview({...base,user:{sub:'user',permissions:['appointments.view']}},res,e=>{throw e});assert.equal(res.statusCode,403)
  })
  assert.equal(writes,0)
})
