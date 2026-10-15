const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb,createDeliveredOrder,configureAccounting}=require('./helpers/commercialAgendaFixture.cjs')
test('orders and Cartera expose only accessible engagement origins without widening operational ownership',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await configureAccounting(db,scope,{full:true})
  const order=await createDeliveredOrder(db,scope,f),engagement=await f.paidEngagement('40.00')
  const payment=await db.customerPayment.findFirst({where:{commitments:{some:{engagement_id:engagement.id}}}})
  const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,role_name:'admin'},query:{}}
  const mocks={[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}}
  await withMocks(mocks,require.resolve('../src/modules/orders/controller'),async controller=>{
    const result=jsonResponse();await controller.getById({...req,params:{id:order.id}},result,e=>{throw e});assert.equal(result.body.engagementId,engagement.id)
    const hidden=jsonResponse();await controller.getById({...req,user:{sub:crypto.randomUUID(),permissions:['orders.view','appointments.view']},params:{id:order.id}},hidden,e=>{throw e});assert.equal(hidden.body.engagementId,null)
  })
  await withMocks(mocks,require.resolve('../src/modules/receivables/controller'),async controller=>{
    const result=jsonResponse();await controller.statement({...req,params:{id:f.contactId}},result,e=>{throw e});assert.equal(result.body.cobros.find(p=>p.id===payment.id).engagementId,engagement.id)
    const hidden=jsonResponse();await controller.statement({...req,user:{sub:crypto.randomUUID(),permissions:['receivables.view','appointments.view']},params:{id:f.contactId}},hidden,e=>{throw e});assert.equal(hidden.body.cobros.find(p=>p.id===payment.id).engagementId,null)
  })
  const permissions=['appointments.view','appointments.collect','appointments.issue_sale','receivables.view','receivables.manage','sales.create']
  const read=extra=>require('../src/modules/appointments/engagements').getEngagement(db,{...scope,isAdmin:false,permissions:[...permissions,...extra]},engagement.id)
  const sourceDenied=await read([]);assert.equal(sourceDenied.capabilities.collect,false);assert.equal(sourceDenied.capabilities.issueSale,false)
  const invoiceDenied=await read(['quotes.view']);assert.equal(invoiceDenied.capabilities.collect,true);assert.equal(invoiceDenied.capabilities.issueSale,false)
  const granted=await read(['quotes.view','orders.view','orders.manage']);assert.equal(granted.capabilities.issueSale,true)
}))
