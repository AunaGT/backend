const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const enabled=process.env.AUNA_CHECKOUT_DEV_TESTS==='approved'
async function database(run){
  require('../src/config/loadEnv')
  const direct=new URL(process.env.DIRECT_URL),configured=new URL(process.env.DATABASE_URL)
  assert.equal(direct.hostname,configured.hostname);assert.equal(direct.username,configured.username);assert.equal(direct.pathname,configured.pathname)
  assert.equal(direct.hostname,'aws-1-us-east-2.pooler.supabase.com');assert.equal(direct.pathname,'/postgres')
  const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:direct.toString()}}})
  try{await run(db)}finally{await db.$disconnect()}
}
test('development checkout and partial order replay keep one sale and payment; all fixture writes roll back',{skip:!enabled},()=>database(async db=>{
  const companyId=randomUUID(),rollback=new Error('ROLLBACK_CHECKOUT_FIXTURE')
  await assert.rejects(db.$transaction(async tx=>{
    const actor=await tx.user.findFirst({where:{role:{name:'admin'}}}),method=await tx.paymentMethod.findFirst({where:{is_credit:false,company_id:null}}),status=await tx.stockStatus.findFirst()
    assert.ok(actor&&method&&status,'existing admin, method and status required; no seed')
    await tx.company.create({data:{id:companyId,name:'QA checkout rollback',code:companyId.slice(0,16)}})
    const branch=await tx.branch.create({data:{company_id:companyId,name:'QA checkout',code:'QAC'}})
    await tx.companyModule.createMany({data:['sales','inventory','orders','contacts'].map(module_code=>({company_id:companyId,module_code,status:'ACTIVE'}))})
    await tx.systemSetting.createMany({data:[['inventory_services_enabled','true'],['fel_enabled','false']].map(([key,value])=>({company_id:companyId,key,value,type:'boolean'}))})
    await tx.companyPaymentMethod.create({data:{company_id:companyId,payment_method_id:method.id,enabled:true}})
    const category=await tx.productCategory.create({data:{company_id:companyId,name:'QA services'}})
    const product=await tx.product.create({data:{company_id:companyId,category_id:category.id,status_id:status.id,name:'QA hour',kind:'SERVICE',service_unit_label:'Hour',quantity_decimals:2,price:10,cost:0}})
    const register=await tx.cashRegister.create({data:{branch_id:branch.id,name:'QA checkout',code:'QAC'}})
    await tx.cashRegisterSession.create({data:{cash_register_id:register.id,opened_by_id:actor.id,opening_float:0}})
    const context={companyId,branchId:branch.id,user:{sub:actor.id,role:{name:'admin'},permissions:[]}}
    const key=randomUUID(),req={...context,body:{idempotency_key:key,items:[{product_id:product.id,qty:'1.5',price:10}],payment_method_id:method.id,cash_register_id:register.id,amount_received:20,change:5}}
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:{$transaction:fn=>fn(tx)}}},require.resolve('../src/modules/sales/controller'),async sales=>{
      const first=jsonResponse();await sales.create(req,first,e=>{throw e});assert.equal(first.statusCode,201)
      const again=jsonResponse();await sales.create(req,again,e=>{throw e});assert.equal(again.body.id,first.body.id)
      assert.equal(await tx.sale.count({where:{branch_id:branch.id,idempotency_key:key}}),1)
      assert.equal(await tx.customerPayment.count({where:{branch_id:branch.id}}),0)
      assert.equal(await tx.stockMovement.count({where:{branch_id:branch.id}}),0)
      const lookup=jsonResponse();await sales.checkoutAttempt({...context,params:{key}},lookup,e=>{throw e});assert.equal(lookup.body.saleId,first.body.id)
      let conflict;await sales.create({...req,body:{...req.body,amount_received:30}},jsonResponse(),e=>{conflict=e});assert.equal(conflict?.code,'CHECKOUT_CONFLICT')
    })
    const order=await tx.commercialDocument.create({data:{branch_id:branch.id,doc_type:'ORDER',status:'CONFIRMED',fulfillment_mode:'LEGACY',customer:'QA',total:20,subtotal:20,created_by:actor.id,lines:{create:{product_id:product.id,item_kind:'SERVICE',item_name:'QA hour',unit_label:'Hour',quantity_decimals:2,qty:2,unit_price:10,line_total:20}}},include:{lines:true}})
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:{$transaction:fn=>fn(tx)}}},require.resolve('../src/modules/orders/controller'),async orders=>{
      const orderReq={...context,params:{id:order.id},body:{idempotency_key:randomUUID(),payment_method_id:method.id,cash_register_id:register.id,lines:[{line_id:order.lines[0].id,qty:1}]}}
      const first=jsonResponse();await orders.convertToSale(orderReq,first,e=>{throw e});assert.ok(first.body.sale.id)
      const replay=jsonResponse();await orders.convertToSale(orderReq,replay,e=>{throw e});assert.equal(replay.body.sale.id,first.body.sale.id)
      assert.equal(String((await tx.commercialDocumentLine.findUnique({where:{id:order.lines[0].id}})).qty_fulfilled),'1')
      assert.equal(await tx.commercialDocumentSale.count({where:{document_id:order.id}}),1)
    })
    throw rollback
  },{timeout:90000,maxWait:10000}),error=>error===rollback)
  assert.equal(await db.company.count({where:{id:companyId}}),0)
}))
test('development transaction lock excludes a concurrent connection and releases on rollback',{skip:!enabled},()=>database(async db=>{
  const {lockCheckoutAttempt}=require('../src/modules/sales/checkoutAttempts'),key=randomUUID(),branchId=randomUUID(),rollback=Error('rollback')
  await assert.rejects(db.$transaction(async tx=>{
    await lockCheckoutAttempt(tx,branchId,key)
    const result=await db.$transaction(other=>other.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${`checkout:${branchId}:${key}`},0)) AS acquired`)
    assert.equal(result[0].acquired,false)
    throw rollback
  }),error=>error===rollback)
  const result=await db.$transaction(tx=>tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${`checkout:${branchId}:${key}`},0)) AS acquired`)
  assert.equal(result[0].acquired,true)
}))
