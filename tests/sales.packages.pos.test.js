const test=require('node:test'),assert=require('node:assert/strict')
const {agreementFixture}=require('./helpers/packageAgreementFixture')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
test('POS charges a package-only cart once, persists components and recovers the same checkout',{timeout:10000},async()=>{
 const f=await agreementFixture(),tx=f.db,turn={id:'00000000-0000-4000-8000-000000000899',status:'OPEN',opened_by_id:f.scope.actorId,register_active:true,register_kind:'PHYSICAL'}
 let stored=null,lines=[],dispatches=0,payments=0,availability=[]
 const findProducts=tx.product.findMany
 tx.product.findMany=async query=>{
  const {company,...where}=query.where
  if(company)assert.deepEqual(company,{branches:{some:{id:f.scope.branchId}}})
  return findProducts({...query,where})
 }
 tx.branch.findUnique=async()=>({id:f.scope.branchId,code:'QA'})
 tx.cashRegister={findFirst:async()=>({id:'R'})};tx.cashRegisterSession={findFirst:async()=>turn}
 tx.saleStatus={findFirst:async()=>({id:1})}
 tx.companyPaymentMethod={findFirst:async()=>({enabled:true,payment_method:{id:1,name:'Efectivo',is_credit:false,settlement_kind:'CASH'}})}
 tx.sale={findFirst:async()=>stored,create:async({data})=>(stored={id:'V',...data})};tx.saleItem={createMany:async({data})=>{lines=data}}
 tx.$queryRaw=async sql=>String(sql).includes('cash_register_sessions')?[turn]:[]
 const paymentsModule=require.resolve('../src/services/commercialPayment'),application=require('../src/modules/sales/application')
 const mocks={
  [require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:tx},
  [require.resolve('../src/services/referenceGenerator')]:{nextDocumentReference:async()=> 'V-QA'},
  [paymentsModule]:{...require(paymentsModule),recordInitialPayment:async()=>payments++},
  [require.resolve('../src/services/stockAvailability')]:{assertLinesAvailable:async(_db,items)=>{availability=items}},
  [require.resolve('../src/modules/sales/application')]:{...application,createSaleRecordAndStock:async(db,options)=>{const sale=await application.insertSaleRecord(db,options);dispatches++;return sale}},
  [require.resolve('../src/modules/cash-closure/events')]:{recordMoneyEvent:async()=>{}},
  [require.resolve('../src/modules/config/hardware/drawer/events')]:{requestHardwareScope:()=>({}),enqueueDrawerIntent:async()=>{}},
  [require.resolve('../src/modules/sales/fiscalRequests')]:{preparePosFiscalRequest:async()=>{}},
 }
 await withMocks(mocks,require.resolve('../src/modules/sales/controller'),async api=>{
  const req={companyId:f.scope.companyId,branchId:f.scope.branchId,user:{sub:f.scope.actorId,permissions:['sales.create']},query:{response:'confirmation'},body:{items:[],packages:[f.selection()],payment_method_id:1,cash_register_id:'R',idempotency_key:'package-attempt',amount_received:1600}}
  const res=jsonResponse();await api.create(req,res,error=>{throw error})
  assert.equal(res.statusCode,201);assert.equal(stored.total,1599);assert.equal(stored.package_groups.length,1);assert.equal(lines.length,3)
  assert.ok(lines.every(l=>l.package_component_key));assert.equal(availability.length,3)
  assert.equal(lines.reduce((sum,l)=>sum+Number(l.net_total),0),1599)
  const retry=jsonResponse();await api.create(req,retry,error=>{throw error});assert.equal(retry.statusCode,200);assert.equal(dispatches,1);assert.equal(payments,1)
  const changed={...req,body:{...req.body,packages:[{...f.selection(),groupId:'00000000-0000-4000-8000-000000000887'}]}}
  const conflict=jsonResponse();let failure;await api.create(changed,conflict,error=>{failure=error});assert.equal(failure.status,409);assert.equal(failure.code,'CHECKOUT_CONFLICT');assert.equal(dispatches,1)
 })
})
