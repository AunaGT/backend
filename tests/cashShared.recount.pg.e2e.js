const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashSharedQa.cjs'),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const url=process.env.AUNA_CASH_DAILY_QA_URL
test('shared recount may be declared by an authorized manager without changing the prior actor or snapshot', {skip:!url,timeout:120000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await fixture(db),turn=await f.open()
  await db.$transaction(tx=>require('../src/modules/cash-closure/physicalMovements').createPhysicalMovement(tx,{...f.scope,canCreateOwn:true},{requestKey:randomUUID(),cashRegisterSessionId:turn.id,direction:'IN',amount:'10.00',paymentMethodId:f.method.id,reason:'Aporte real',counterpartyLabel:'Caja fuerte'}))
  await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${turn.id}::uuid`
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/cash-closure/controller'),async api=>{
   const declare=async(scope,permissions)=>{
    const req={companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,name:'Declarador QA',permissions},query:{cashier_id:scope.userId,cash_register_session_id:turn.id}}
    const calc=await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db,req),res=jsonResponse();let error
    await api.create({...req,body:{cashierId:scope.userId,cash_register_session_id:turn.id,calculationKey:calc.calculation_key,actualTotal:'10.00',paymentBreakdowns:calc.payment_breakdown.map(m=>({...m,actual_amount:String(m.theoretical_amount)})),denominations:[]}},res,e=>error=e)
    if(error)throw error;assert.equal(res.statusCode,201,JSON.stringify(res.body));return res.body
   }
   const original=await declare(f.scope,['cashclosure.create_own'])
   const [before]=await db.$queryRaw`SELECT calculation_snapshot,cashier_id,updated_at FROM cash_closures WHERE id=${original.id}::uuid`
   await db.$transaction(tx=>require('../src/modules/cash-closure/reviewFlow').requestRecount(tx,{...f.otherScope,canReview:true},original.id,{expectedUpdatedAt:before.updated_at.toISOString(),reason:'Segundo conteo'}))
   const next=await declare(f.otherScope,['cashclosure.create'])
   const [old]=await db.$queryRaw`SELECT calculation_snapshot,cashier_id,status FROM cash_closures WHERE id=${original.id}::uuid`
   assert.equal(old.status,'Sustituido');assert.deepEqual(old.calculation_snapshot,before.calculation_snapshot);assert.equal(old.cashier_id,f.user.id)
   assert.equal(next.cashier_id,f.other.id)
  })
 }finally{await db.$disconnect()}
})
