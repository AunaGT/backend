const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {makePayablesFixture}=require('./helpers/payablesFixture.cjs')
const payables=require('../src/modules/merchandise/payables')
const returns=require('../src/modules/returns/application')
test('customer payment deletion denies collectors before loading or deleting records',async()=>{
 const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{}}},require.resolve('../src/modules/receivables/controller'),async controller=>{
  let failure;await controller.deletePayment({companyId:'A',user:{sub:'U',permissions:['receivables.manage']},params:{id:'P'}},jsonResponse(),e=>{failure=e})
  assert.equal(failure?.status,403)
 })
})
test('supplier correction services reject payment collectors before writes',async()=>{
  const f=makePayablesFixture();f.scope.permissions=['merchandise.mark_paid','merchandise.details']
  for(const invoke of [
    ()=>payables.cancelSupplierPayment(f.db,f.scope,randomUUID(),{reason:'Corrección autorizada'}),
    ()=>payables.cancelLegacyEntry(f.db,f.scope,f.stored.entries[0].id,randomUUID(),{reason:'Corrección autorizada'}),
    ()=>payables.correctHistoricalSettlement(f.db,f.scope,f.stored.entries[0].id,{amount:'0.00',expectedRevision:0,reason:'Corrección autorizada'}),
  ])await assert.rejects(invoke,e=>e.status===403)
  assert.equal(f.stored.events.length,0)
})
test('return application services require their own authority even outside HTTP',async()=>{
  const db={return:{findFirst:async()=>{throw Error('Must deny before accessing return')}}}
  await assert.rejects(returns.approveReturn(db,{permissions:['returns.manage']}),e=>e.status===403)
  await assert.rejects(returns.completeReturn({$transaction:async fn=>fn(db)},{permissions:['returns.manage']}),e=>e.status===403)
})
test('settlement-only cash lookup returns only the actors own open session and no financial details',async()=>{
 const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
 const db={cashRegister:{findFirst:async()=>({id:'R',name:'Caja',code:'C',active:true,branch_id:'B'})},cashRegisterSession:{findFirst:async({where,select})=>{
  assert.equal(where.opened_by_id,'U');assert.equal(where.cash_register_id,'R');assert.equal(where.status,'OPEN')
  assert.deepEqual(select,{id:true,status:true});return{id:'SESSION',status:'OPEN'}
 }}}
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/sales/cashSessions.controller'),async controller=>{
  const res=jsonResponse();await controller.getCurrent({companyId:'A',branchId:'B',query:{cash_register_id:'R'},user:{sub:'U',permissions:['returns.complete']}},res,e=>{throw e})
  assert.equal(res.statusCode,200);assert.equal(res.body.session.id,'SESSION');assert.deepEqual(Object.keys(res.body.register).sort(),['code','id','name'])
 })
})
test('a legacy role name cannot administer cash sessions',async()=>{
 const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:{}}},require.resolve('../src/modules/sales/cashSessions.controller'),async controller=>{
  const res=jsonResponse();await controller.openSession({user:{sub:'U',role:{name:'Admin'},permissions:[]},body:{}},res,e=>{throw e})
  assert.equal(res.statusCode,403)
 })
})
