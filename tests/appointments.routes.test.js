require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
test('controller devuelve validación estructurada y no deja pasar precio enviado por cliente', async () => {
  let writes = 0
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: {}, prismaTransaction: { $transaction: async () => { writes++ } } } }, path.resolve(__dirname, '../src/modules/appointments/controller.js'), async c => {
    const res = jsonResponse()
    await c.createBooking({ companyId: 'company', branchId: 'branch', user: { sub: 'user', role: 'admin', permissions: ['appointments.view'] }, body: { paid: true } }, res, error => { throw error })
    assert.equal(res.statusCode, 400); assert.equal(res.body.code, 'INVALID_INPUT'); assert.ok(res.body.fields.paid)
  })
  assert.equal(writes, 0)
})
test('todas las rutas son privadas, literales y transiciones reautorizan la acción', () => {
  const router = require('../src/modules/appointments/routes')
  assert.equal(router.stack[0].handle, require('../src/middlewares/autenticacion').Auth)
  const paths = router.stack.filter(l => l.route).map(l => l.route.path)
  assert.ok(paths.includes('/summary')); assert.ok(paths.includes('/sessions/:id/waitlist'))
  assert.ok(paths.includes('/activities')); assert.ok(paths.includes('/activities/:id/transition')); assert.ok(paths.includes('/activity-users'))
  assert.ok(paths.includes('/bookings/:id/transition')); assert.equal(paths.some(p => p.includes('public')), false)
})
test('commercial collection is exposed through the protected controller with structured validation', async () => {
  const router=require('../src/modules/appointments/routes')
  const route=router.stack.find(l=>l.route?.path==='/engagements/:id/payments')
  assert.ok(route?.route.methods.post)
  let writes=0
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{},prismaTransaction:{$transaction:async()=>{writes++}}}},path.resolve(__dirname,'../src/modules/appointments/controller.js'),async c=>{
    const res=jsonResponse()
    await c.collectEngagementPayment({companyId:'company',branchId:'branch',user:{sub:'user',role:'admin',permissions:['appointments.view']},params:{id:'bad'},body:{}},res,error=>{throw error})
    assert.equal(res.statusCode,400);assert.equal(res.body.code,'INVALID_INPUT')
  })
  assert.equal(writes,0)
})
test('sale issuance registers a private explicit endpoint and POS rejects internal settlement flags',async()=>{
  const router=require('../src/modules/appointments/routes')
  assert.ok(router.stack.find(l=>l.route?.path==='/engagements/:id/sale')?.route.methods.post)
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{},prismaTransaction:{}}},path.resolve(__dirname,'../src/modules/sales/controller.js'),async c=>{
    const res=jsonResponse();await c.create({user:{sub:'user'},body:{settlement_source:'ENGAGEMENT_RECEIPTS',items:[{}]}},res,error=>{throw error})
    assert.equal(res.statusCode,400);assert.equal(res.body.code,'INVALID_SETTLEMENT')
  })
})
test('fund resolutions have their own financial route and reject missing reason before any transaction',async()=>{
  const router=require('../src/modules/appointments/routes')
  assert.ok(router.stack.find(l=>l.route?.path==='/engagements/:id/resolution')?.route.methods.post)
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{},prismaTransaction:{}}},path.resolve(__dirname,'../src/modules/appointments/controller.js'),async c=>{
    const res=jsonResponse();await c.resolveEngagementFunds({companyId:'company',branchId:'branch',user:{sub:'user',role_name:'admin',permissions:['appointments.view']},params:{id:'11111111-1111-4111-8111-111111111111'},body:{action:'KEEP',reason:'',expectedVersion:1,idempotencyKey:'resolution'}},res,error=>{throw error})
    assert.equal(res.statusCode,400);assert.equal(res.body.code,'INVALID_INPUT')
  })
})
