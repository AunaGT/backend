const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashSharedQa.cjs'),{withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const url=process.env.AUNA_CASH_DAILY_QA_URL
test('real POS and receivable writers accept joined participants, reject outsiders and preserve actor identities', {skip:!url,timeout:120000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await fixture(db),turn=await f.open()
  await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
  await db.systemSetting.create({data:{company_id:f.company.id,key:'inventory_services_enabled',value:'true'}})
  const category=await db.productCategory.create({data:{company_id:f.company.id,name:'Servicios'}}),status=await db.stockStatus.upsert({where:{name:'Disponible QA'},create:{name:'Disponible QA'},update:{}})
  const product=await db.product.create({data:{company_id:f.company.id,category_id:category.id,status_id:status.id,name:'Servicio QA',kind:'SERVICE',service_unit_label:'Servicio',quantity_decimals:0,price:100,cost:0}})
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/sales/controller'),async api=>{
   const sell=async scope=>{
    const res=jsonResponse();let error
    await api.create({companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,permissions:['sales.create']},query:{response:'confirmation'},body:{cash_register_id:f.register2.id,payment_method_id:f.method.id,idempotency_key:randomUUID(),sales_channel:'WHOLESALE',items:[{product_id:product.id,qty:1}]}},res,e=>error=e)
    if(error)throw error;assert.equal(res.statusCode,201)
   }
   await assert.rejects(sell(f.otherScope),e=>e.status===403)
   await db.$transaction(tx=>require('../src/services/cashSharedSessions').join(tx,f.otherScope,turn.id))
   await sell(f.scope);await sell(f.otherScope)
  })
  for(const scope of [f.scope,f.otherScope])await db.$transaction(tx=>require('../src/modules/receivables').applyPayment(tx,{...scope,customerId:f.customer.id,amount:50,paymentMethodId:f.method.id,cashRegisterSessionId:turn.id,allowAdvance:true}))
  const events=await db.$queryRaw`SELECT actor_id,source_type FROM cash_money_events WHERE cash_register_session_id=${turn.id}::uuid`
  for(const scope of [f.scope,f.otherScope])assert.deepEqual(events.filter(e=>e.actor_id===scope.userId).map(e=>e.source_type).sort(),['CUSTOMER_PAYMENT','SALE'])
 }finally{await db.$disconnect()}
})
