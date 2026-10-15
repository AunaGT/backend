const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {withCommercialAgendaTestDb}=require('./helpers/commercialAgendaFixture.cjs')
test('private quote metadata opens one authorized engagement while public quotes and other operational owners do not receive its ID',async()=>withCommercialAgendaTestDb(async({db,scope,fixtures:f})=>{
  const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/quotes/controller'),async controller=>{
    const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,role_name:'admin'},params:{id:f.quoteId}}
    const initial=jsonResponse();await controller.getById(req,initial,error=>{throw error})
    assert.equal(initial.body.agenda.canCreate,true);assert.equal(initial.body.engagementId,null)
    const e=await require('../src/modules/appointments/engagements').createEngagement(db,scope,{quoteId:f.quoteId,idempotencyKey:crypto.randomUUID()})
    const existing=jsonResponse();await controller.getById(req,existing,error=>{throw error})
    assert.equal(existing.body.engagementId,e.id);assert.equal(existing.body.agenda.canOpen,true)
    const forbidden=jsonResponse();await controller.getById({...req,user:{sub:crypto.randomUUID(),permissions:['quotes.view','appointments.view','appointments.create']}},forbidden,error=>{throw error})
    assert.equal(forbidden.body.engagementId,null);assert.equal(forbidden.body.agenda.canCreate,false)
  })
}))
