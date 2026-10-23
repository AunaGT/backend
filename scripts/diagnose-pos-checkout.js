// Manual development diagnostic: real controller/database, one existing product,
// all writes rolled back. Never starts HTTP, prints business data or sends a ticket.
const {performance}=require('node:perf_hooks')
const {randomUUID}=require('node:crypto')

async function rollbackCheckout(db,run){
 const rollback=Error('CHECKOUT_DIAGNOSTIC_ROLLBACK')
 let result,finished=false
 try{
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1500ms'")
   result=await run(tx)
   finished=true
   throw rollback
  },{timeout:45000,maxWait:5000})
 }catch(error){if(error!==rollback)throw error}
 if(!finished)throw Error('ROLLBACK_NOT_CONFIRMED')
 return result
}

async function quietDiagnostic(run,logger=console){
 const methods=['log','info','warn','error'],saved=Object.fromEntries(methods.map(key=>[key,logger[key]]))
 let suppressedMessages=0
 try{
  for(const key of methods)logger[key]=()=>{suppressedMessages++}
  return{value:await run(),suppressedMessages}
 }finally{for(const key of methods)logger[key]=saved[key]}
}

async function main(args){
 const lineCount=parseDiagnosticArgs(args)
 require('../src/config/loadEnv')
 const {PrismaClient}=require('@prisma/client')
 const pooled=new URL(process.env.DATABASE_URL),session=new URL(process.env.DIRECT_URL)
 if(pooled.hostname!==session.hostname||pooled.username!==session.username||pooled.pathname!==session.pathname||!session.hostname.endsWith('.supabase.com'))throw Error('DATABASE_SCOPE_MISMATCH')
 const clients=[],queries=[]
 let recording=false
 const make=url=>{
  const client=new PrismaClient({datasources:{db:{url:url.toString()}},log:[{emit:'event',level:'query'}]})
  client.$on('query',event=>{
   if(!recording)return
   const operation=/^\s*([A-Z]+)/i.exec(event.query)?.[1]?.toUpperCase()??'OTHER'
   const table=/\b(?:FROM|INTO|UPDATE)\s+(?:"?public"?\.)?"?([a-z_]+)"?/i.exec(event.query)?.[1]??'transaction'
   queries.push({operation,table,ms:event.duration})
  })
  clients.push(client);return client
 }
 const db=make(pooled),transactions=make(session)
 try{
  const registerSession=await db.cashRegisterSession.findFirst({where:{status:'OPEN',cashRegister:{active:true},openedBy:{role:{name:'admin'}}},include:{cashRegister:true,openedBy:{include:{role:true}}},orderBy:{opened_at:'desc'}})
  if(!registerSession)throw Error('EXISTING_ADMIN_CASH_SESSION_REQUIRED')
  const branch=await db.branch.findUnique({where:{id:registerSession.cashRegister.branch_id}})
  const products=await db.product.findMany({where:{company_id:branch.company_id,deleted:false,kind:'STANDARD',available_for_sale:true,branch_stocks:{some:{branch_id:branch.id,stock:{gte:2}}}},orderBy:{id:'asc'},take:lineCount})
  if(products.length!==lineCount)throw Error('EXISTING_PHYSICAL_PRODUCTS_REQUIRED')
  const preference=await db.companyPaymentMethod.findFirst({where:{company_id:branch.company_id,enabled:true,payment_method:{is_credit:false,settlement_kind:'CASH',OR:[{company_id:null},{company_id:branch.company_id}]}},include:{payment_method:true}})
  if(!preference)throw Error('EXISTING_CASH_METHOD_REQUIRED')
  const key=randomUUID(),request={companyId:branch.company_id,branchId:branch.id,query:{response:'confirmation'},user:{sub:registerSession.opened_by_id,role:registerSession.openedBy.role,permissions:['sales.create']},body:{idempotency_key:key,customer:'Consumidor final',customer_nit:'CF',is_final_consumer:true,sales_channel:'POS',cash_register_id:registerSession.cash_register_id,payment_method_id:preference.payment_method_id,items:products.map(product=>({product_id:product.id,qty:'1',price:String(product.price),...(product.base_unit_id?{presentation_id:null,unit_revision:product.unit_revision}:{})}))}}
  const {withMocks,jsonResponse}=require('../tests/helpers/reportHarness.cjs')
  let saleId,controllerMs
  // Warm both connections before timing; no connection/runtime settings are changed.
  await db.$queryRawUnsafe('SELECT 1');await transactions.$queryRawUnsafe('SELECT 1')
  recording=true
  const {suppressedMessages}=await quietDiagnostic(()=>rollbackCheckout(transactions,async tx=>{
   await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:{$transaction:run=>run(tx)}}},require.resolve('../src/modules/sales/controller'),async sales=>{
    const response=jsonResponse(),start=performance.now()
    await sales.create(request,response,error=>{throw error})
    controllerMs=performance.now()-start
    if(response.statusCode!==201||response.body?.checkout_state!=='CONFIRMED')throw Error('CHECKOUT_NOT_CONFIRMED')
    saleId=response.body.id
   })
  }))
  recording=false
  if(await db.sale.count({where:{branch_id:branch.id,idempotency_key:key}})!==0||await db.stockMovement.count({where:{ref_type:'sale',ref_id:saleId}})!==0||(await db.$queryRaw`SELECT id FROM sale_stock_alert_outbox WHERE sale_id=${saleId}::uuid`).length)throw Error('ROLLBACK_VERIFICATION_FAILED')
  const groups=new Map()
  for(const row of queries){const label=`${row.operation} ${row.table}`,value=groups.get(label)??{label,count:0,sqlMs:0};value.count++;value.sqlMs+=row.ms;groups.set(label,value)}
  console.log(JSON.stringify({scope:'controller-only; excludes HTTP auth, unit preview, commit and ticket',lines:lineCount,rolledBack:true,suppressedMessages,controllerMs:Number(controllerMs.toFixed(2)),sqlStatements:queries.length,queries:[...groups.values()].sort((a,b)=>b.sqlMs-a.sqlMs)},null,2))
 }finally{await Promise.all(clients.map(client=>client.$disconnect()))}
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({status:'error',code:/^[A-Z_]+$|^P\d{4}$/.test(error?.code??error?.message??'')?(error.code??error.message):'DIAGNOSTIC_FAILED'}));process.exitCode=1})
function parseDiagnosticArgs(args){
 if(args[0]!=='--rollback'||args.length<1||args.length>2||args[1]!==undefined&&!/^--lines=(1|3|10)$/.test(args[1]))throw Error('ROLLBACK_OPT_IN_REQUIRED')
 return args[1]?Number(args[1].slice(8)):1
}
module.exports={rollbackCheckout,quietDiagnostic,parseDiagnosticArgs}
