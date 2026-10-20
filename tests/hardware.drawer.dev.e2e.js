const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const enabled=process.env.AUNA_HARDWARE_DEV_TESTS==='approved'
async function database(run){
 require('../src/config/loadEnv')
 const direct=new URL(process.env.DIRECT_URL),configured=new URL(process.env.DATABASE_URL)
 assert.equal(direct.hostname,configured.hostname);assert.equal(direct.username,configured.username);assert.equal(direct.pathname,configured.pathname)
 assert.equal(direct.hostname,'aws-1-us-east-2.pooler.supabase.com');assert.equal(direct.pathname,'/postgres')
 const {PrismaClient}=require('@prisma/client'),db=new PrismaClient({datasources:{db:{url:direct.toString()}}})
 try{await run(db)}finally{await db.$disconnect()}
}
async function fixture(tx,companyId){
 const actor=await tx.user.findFirst({where:{role:{name:'admin',system_key:'ADMIN',company_id:null}},include:{role:true}}),method=await tx.paymentMethod.findFirst({where:{company_id:null,settlement_kind:'CASH',is_credit:false}}),stock=await tx.stockStatus.findFirst(),status=await tx.saleStatus.findFirst({where:{name:'Completada'}})
 assert.ok(actor&&method&&stock&&status,'existing catalogs required; no general seed')
 await tx.company.create({data:{id:companyId,name:'QA hardware temporary',code:companyId.slice(0,16)}})
 const branch=await tx.branch.create({data:{company_id:companyId,name:'QA hardware',code:'QAH'}})
 await tx.companyModule.createMany({data:['inventory','sales','contacts'].map(module_code=>({company_id:companyId,module_code,status:'ACTIVE'}))})
 await tx.systemSetting.createMany({data:[['inventory_services_enabled','true'],['fel_enabled','false']].map(([key,value])=>({company_id:companyId,key,value,type:'boolean'}))})
 await tx.companyPaymentMethod.create({data:{company_id:companyId,payment_method_id:method.id,enabled:true}})
 const category=await tx.productCategory.create({data:{company_id:companyId,name:'QA'}}),product=await tx.product.create({data:{company_id:companyId,category_id:category.id,status_id:stock.id,name:'QA service',kind:'SERVICE',service_unit_label:'Hour',quantity_decimals:0,price:10,cost:0}})
 const register=await tx.cashRegister.create({data:{branch_id:branch.id,name:'QA hardware',code:'QAH'}})
 const station=await tx.hardwareWorkstation.create({data:{company_id:companyId,branch_id:branch.id,cash_register_id:register.id,name:'QA station',code:'QAH',state:'ACTIVE'}})
 const printer=await tx.hardwareDevice.create({data:{company_id:companyId,branch_id:branch.id,name:'QA printer',code:'QAP',kind:'RECEIPT_PRINTER',connection:'SYSTEM_PRINTER',state:'ACTIVE',profile:{widthMm:80,copies:1}}})
 const drawer=await tx.hardwareDevice.create({data:{company_id:companyId,branch_id:branch.id,name:'QA drawer',code:'QAD',kind:'CASH_DRAWER',connection:'PRINTER_PORT',state:'ACTIVE',profile:{parentPrinterId:printer.id}}})
 await tx.hardwareAssignment.createMany({data:[['RECEIPT',printer.id],['DRAWER',drawer.id]].map(([role,device_id])=>({company_id:companyId,branch_id:branch.id,workstation_id:station.id,device_id,role}))})
 const session=await tx.cashRegisterSession.create({data:{cash_register_id:register.id,opened_by_id:actor.id,opening_float:0}})
 return{companyId,actor,method,status,branch,product,register,station,drawer,session,scope:{companyId,branchId:branch.id,actorId:actor.id,isAdmin:true,permissions:[]}}
}
test('real POS transaction creates one intent and immutable ticket; all fixture changes roll back',{skip:!enabled},()=>database(async db=>{
 const companyId=randomUUID(),rollback=Error('ROLLBACK_HARDWARE_FIXTURE')
 await assert.rejects(db.$transaction(async tx=>{
  const f=await fixture(tx,companyId),req={companyId,branchId:f.branch.id,user:{sub:f.actor.id,role:f.actor.role,permissions:[]},body:{idempotency_key:randomUUID(),items:[{product_id:f.product.id,qty:1,price:10}],payment_method_id:f.method.id,cash_register_id:f.register.id,amount_received:20,change:10}}
  const wrapped={...tx,$transaction:fn=>fn(tx)}
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:tx,prismaTransaction:wrapped}},require.resolve('../src/modules/sales/controller'),async sales=>{
   const first=jsonResponse();await sales.create(req,first,e=>{throw e});assert.equal(first.statusCode,201)
   const replay=jsonResponse();await sales.create(req,replay,e=>{throw e});assert.equal(replay.body.id,first.body.id)
   const intents=await tx.hardwareDrawerIntent.findMany({where:{company_id:companyId}});assert.equal(intents.length,1);assert.equal(intents[0].amount.toString(),'10')
   assert.equal(await tx.customerPayment.count({where:{branch_id:f.branch.id}}),0)
   const jobs=require('../src/modules/config/hardware/printing/service'),input={requestKey:randomUUID(),source:{kind:'SALE_TICKET',id:first.body.id},document:'MAIN'}
   const job=await jobs.createJob(wrapped,f.scope,input);assert.equal((await jobs.createJob(wrapped,f.scope,input)).id,job.id)
   const snapshot=await jobs.jobDocument(tx,f.scope,job.id);assert.equal(snapshot.sale.total,'10');assert.equal(snapshot.sale.sale_items[0].item_name,'QA service')
   await jobs.recordEvent(wrapped,f.scope,job.id,{requestKey:randomUUID(),event:'PREPARED'})
   assert.equal(await tx.hardwareDrawerIntent.count({where:{company_id:companyId}}),1)
  })
  throw rollback
 },{timeout:90000,maxWait:10000}),e=>e===rollback)
 assert.equal(await db.company.count({where:{id:companyId}}),0)
}))
test('two real database connections race for one claim; temporary fixture is removed',{skip:!enabled},()=>database(async db=>{
 const companyId=randomUUID();let f
 try{
  f=await db.$transaction(tx=>fixture(tx,companyId),{timeout:60000,maxWait:10000})
  const intent=await db.$transaction(async tx=>{
   const sale=await tx.sale.create({data:{branch_id:f.branch.id,created_by:f.actor.id,total:10,adjusted_total:10,items:0,status_id:f.status.id,payment_method_id:f.method.id,cash_register_session_id:f.session.id}})
   return require('../src/modules/config/hardware/drawer/events').enqueueDrawerIntent(tx,f.scope,{origin:'POS_SALE',sourceId:sale.id})
  },{timeout:20000})
  assert.ok(intent.intentId)
  const {claimIntent,recordResult}=require('../src/modules/config/hardware/drawer/intents'),input={intentId:intent.intentId,workstationId:f.station.id,mode:'SIMULATED'}
  const results=await Promise.allSettled([1,2].map(()=>claimIntent(db,f.scope,{...input,requestKey:randomUUID()})))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await db.hardwareDrawerAttempt.count({where:{company_id:companyId}}),1)
  const claim=results.find(r=>r.status==='fulfilled').value
  const result=await recordResult(db,f.scope,intent.intentId,{attemptId:claim.attemptId,claimToken:claim.claimToken,outcome:'SIMULATED'});assert.equal(result.state,'SIMULATED')
 }finally{
  if(f)await db.$transaction(async tx=>{
   await tx.hardwareDrawerAttempt.deleteMany({where:{company_id:companyId}});await tx.hardwareDrawerIntent.deleteMany({where:{company_id:companyId}})
   await tx.sale.deleteMany({where:{branch_id:f.branch.id}});await tx.cashRegisterSession.deleteMany({where:{cash_register_id:f.register.id}})
   await tx.hardwareAssignment.deleteMany({where:{company_id:companyId}});await tx.hardwareWorkstation.deleteMany({where:{company_id:companyId}});await tx.hardwareDevice.deleteMany({where:{company_id:companyId}})
   await tx.cashRegister.deleteMany({where:{id:f.register.id}});await tx.product.deleteMany({where:{company_id:companyId}});await tx.productCategory.deleteMany({where:{company_id:companyId}})
   await tx.companyPaymentMethod.deleteMany({where:{company_id:companyId}});await tx.systemSetting.deleteMany({where:{company_id:companyId}});await tx.companyModule.deleteMany({where:{company_id:companyId}})
   await tx.branch.deleteMany({where:{id:f.branch.id,company_id:companyId}});await tx.company.deleteMany({where:{id:companyId}})
  },{timeout:30000,maxWait:10000})
 }
 assert.equal(await db.company.count({where:{id:companyId}}),0)
}))
