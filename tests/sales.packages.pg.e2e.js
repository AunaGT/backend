// Opt-in only: synthetic records in a loopback, already migrated, disposable packages database.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const target=process.env.PACKAGES_TEST_DATABASE_URL
let endpoint
try{endpoint=new URL(target)}catch{throw Error('PACKAGES_TEST_DATABASE_URL is required')}
if(!['postgres:','postgresql:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||!/^\/auna_packages_test_[a-z0-9_]+$/.test(endpoint.pathname)||endpoint.search||endpoint.hash||target===process.env.DATABASE_URL||target===process.env.DIRECT_URL)throw Error('Refusing a non-isolated packages database')
process.env.DATABASE_URL=target;process.env.DIRECT_URL=target
const {PrismaClient}=require('@prisma/client')
const db=new PrismaClient({datasources:{db:{url:target}}})
const Manual=require('../src/modules/sales/manualSales'),Sales=require('../src/modules/sales/controller')
const {restoreStockMap}=require('../src/services/bomStock'),{getAvailabilityBatch}=require('../src/services/stockAvailability')
test.after(async()=>{await db.$disconnect();await require('../src/models/prisma').$disconnect?.()})

async function setup(stock={base:10,lemon:10}){
 const status=await db.stockStatus.upsert({where:{name:'Disponible'},update:{},create:{name:'Disponible'}})
 for(const name of ['Borrador','Completada','Cancelada'])await db.saleStatus.upsert({where:{name},update:{},create:{name}})
 const role=await db.role.upsert({where:{system_key:'ADMIN'},update:{},create:{name:'admin',system_key:'ADMIN'}})
 const company=await db.company.create({data:{name:'Synthetic package sales',code:randomUUID().slice(0,12)}})
 await db.systemSetting.createMany({data:[{company_id:company.id,key:'currency_code',value:'GTQ'},{company_id:company.id,key:'sales_allow_credit',value:'true'}]})
 // Accounting has its own PG suites; here it is off so the stock path is what is measured.
 await db.companyModule.create({data:{company_id:company.id,module_code:'accounting',status:'DISABLED'}})
 const branch=await db.branch.create({data:{company_id:company.id,name:'Synthetic branch',code:'PKG',is_default:true}})
 const user=await db.user.create({data:{name:'Synthetic seller',email:randomUUID()+'@invalid.test',password:'synthetic-only',role_id:role.id,default_branch_id:branch.id}})
 await db.userCompany.create({data:{company_id:company.id,user_id:user.id,role_id:role.id}})
 await db.userBranch.create({data:{user_id:user.id,branch_id:branch.id}})
 const customer=await db.supplier.create({data:{company_id:company.id,party_type:'CUSTOMER',name:'Synthetic customer',contact:'Synthetic'}})
 const cash=await db.paymentMethod.create({data:{company_id:company.id,name:'Efectivo '+company.code,settlement_kind:'CASH'}})
 await db.companyPaymentMethod.create({data:{company_id:company.id,payment_method_id:cash.id}})
 const credit=await db.paymentMethod.create({data:{company_id:company.id,name:'Crédito '+company.code,settlement_kind:'CREDIT',is_credit:true}})
 await db.companyPaymentMethod.create({data:{company_id:company.id,payment_method_id:credit.id}})
 const register=await db.cashRegister.create({data:{branch_id:branch.id,name:'Caja QA',code:'QA',is_default:true}})
 await db.cashRegisterSession.create({data:{cash_register_id:register.id,opened_by_id:user.id,opening_float:0,status:'OPEN'}})
 const category=await db.productCategory.create({data:{company_id:company.id,name:'Synthetic'}})
 const product=name=>db.product.create({data:{company_id:company.id,name,category_id:category.id,status_id:status.id,kind:'STANDARD',stock:'0',min_stock:'0',cost:'4',price:'10.00'}})
 const base=await product('Shot base'),lemon=await product('Shot limón')
 await db.$transaction(tx=>restoreStockMap(tx,new Map([[base.id,stock.base],[lemon.id,stock.lemon]]),branch.id,{reason:'PURCHASE'}))
 const scope={companyId:company.id,branchId:branch.id,branchIds:[branch.id],userId:user.id,actorId:user.id,isAdmin:true,permissions:['sales.create','sales.cancel','products.view','products.edit','products.packages.publish']}
 // The base product is a fixed component, a choice option and later an independent item: the stock check must add all three.
 const definition={schemaVersion:1,name:'Fiesta QA',description:'',imageUrl:null,currency:'GTQ',variants:[{id:randomUUID(),name:'Barra',price:'150.00',
  components:[{id:randomUUID(),productId:base.id,quantity:'3',presentationId:null,unitRevision:base.unit_revision,weight:'1'}],
  choices:[{id:randomUUID(),name:'Sabores',totalQuantity:'4',maxDistinct:2,weight:'1',options:[{id:randomUUID(),productId:base.id,presentationId:null,unitRevision:base.unit_revision},{id:randomUUID(),productId:lemon.id,presentationId:null,unitRevision:lemon.unit_revision}]}]}]}
 const catalog=require('../src/modules/inventory/packages/catalog')
 const saved=await catalog.savePackage(db,scope,null,{expectedVersion:0,definition,branchIds:[branch.id],idempotencyKey:randomUUID()})
 await catalog.activatePackageVersion(db,scope,saved.id,{expectedVersion:saved.version,idempotencyKey:randomUUID()})
 const [variant]=definition.variants,[choice]=variant.choices
 const selection=(baseQty,lemonQty)=>({groupId:randomUUID(),packageId:saved.id,version:1,variantId:variant.id,choices:[{choiceId:choice.id,items:[...(baseQty?[{optionId:choice.options[0].id,quantity:String(baseQty)}]:[]),...(lemonQty?[{optionId:choice.options[1].id,quantity:String(lemonQty)}]:[])]}]})
 const available=async()=>{const map=await getAvailabilityBatch([base.id,lemon.id],db,{branchId:branch.id});return{base:Number(map[base.id].stock),lemon:Number(map[lemon.id].stock)}}
 const movements=refId=>db.stockMovement.findMany({where:{ref_id:refId}})
 async function draft({packages,items=[]}){
  const raw={expectedVersion:0,idempotencyKey:randomUUID(),customerId:customer.id,customerName:customer.name,customerNit:'',items,packages}
  const preview=await Manual.previewManualSale(db,scope,raw)
  return Manual.saveManualSale(db,scope,null,{...raw,idempotencyKey:randomUUID(),items:items.map((l,i)=>({...l,expected_unit_price:preview.items[i].unitPrice}))})
 }
 const confirm=sale=>Manual.confirmManualSale(db,scope,sale.id,{expectedVersion:sale.version,idempotencyKey:randomUUID(),dueDate:'2099-01-01'})
 return{company,branch,user,role,cash,base,lemon,scope,selection,available,movements,draft,confirm}
}

test('a direct sale with a package and an independent item consumes a shared product exactly once, and a short sale rolls back',async()=>{
 const f=await setup()
 const sale=await f.draft({packages:[f.selection(2,2)],items:[{product_id:f.base.id,qty:'4'}]})
 assert.equal(sale.items.filter(l=>l.packageComponentKey).length,3,'fixed component + two chosen options')
 assert.deepEqual(await f.available(),{base:10,lemon:10},'saving a draft dispatches nothing')
 const done=await f.confirm(sale)
 assert.equal(done.status,'CONFIRMED');assert.equal(done.total,'190.00','package price once + independent item')
 assert.deepEqual(await f.available(),{base:1,lemon:8},'3 fixed + 2 chosen + 4 independent of the shared product')
 const moved=await f.movements(sale.id),byProduct=p=>moved.filter(m=>m.product_id===p).reduce((s,m)=>s+Math.abs(Number(m.qty)),0)
 assert.equal(byProduct(f.base.id),9);assert.equal(byProduct(f.lemon.id),2)

 const short=await f.draft({packages:[f.selection(0,4)]})
 await assert.rejects(f.confirm(short),/stock|existencia|disponible/i)
 assert.deepEqual(await f.available(),{base:1,lemon:8},'the rejected confirmation leaves stock untouched')
 assert.equal((await f.movements(short.id)).length,0)
 assert.equal((await Manual.readManualSale(db,f.scope,short.id)).status,'DRAFT')
})

test('two simultaneous confirmations cannot oversell the shared package product',async()=>{
 const f=await setup({base:10,lemon:10})
 // Each needs 6 of the base product (3 fixed + 3 chosen); only one fits in 10.
 const [a,b]=[await f.draft({packages:[f.selection(3,1)]}),await f.draft({packages:[f.selection(3,1)]})]
 const results=await Promise.allSettled([f.confirm(a),f.confirm(b)])
 assert.deepEqual(results.map(r=>r.status).sort(),['fulfilled','rejected'],JSON.stringify(results.map(r=>r.reason?.message)))
 assert.deepEqual(await f.available(),{base:4,lemon:9})
 const loser=results[0].status==='rejected'?a:b
 assert.equal((await f.movements(loser.id)).length,0,'the losing transaction rolled back completely')
 assert.equal((await Manual.readManualSale(db,f.scope,loser.id)).status,'DRAFT')
})

const call=(fn,req)=>new Promise((resolve,reject)=>{let status=200;const res={status(code){status=code;return res},json(body){resolve({status,body})},set(){return res},setHeader(){}};Promise.resolve(fn(req,res,reject)).catch(reject)})
test('a POS package checkout replayed with the same key charges and dispatches once',async()=>{
 const f=await setup()
 const key=randomUUID(),body={customer:'Consumidor final',customer_nit:'',is_final_consumer:true,payment_method_id:f.cash.id,status_id:0,sales_channel:'POS',
  items:[],packages:[f.selection(1,3)],amount_received:150,change:0,admin_authorized_products:[],promotion_codes:[],idempotency_key:key}
 const req=()=>({body:structuredClone(body),companyId:f.company.id,branchId:f.branch.id,query:{},headers:{},get:()=>undefined,
  user:{sub:f.user.id,role:{name:'admin',system_key:'ADMIN',company_id:null},permissions:['sales.create']}})
 const first=await call(Sales.create,req())
 assert.equal(first.status,201,JSON.stringify(first.body).slice(0,300))
 const replay=await call(Sales.create,req())
 assert.equal(replay.body.id,first.body.id,'the retry returns the same sale')
 assert.equal(await db.sale.count({where:{branch_id:f.branch.id}}),1)
 assert.equal(Number((await db.sale.findUnique({where:{id:first.body.id}})).total),150)
 assert.deepEqual(await f.available(),{base:6,lemon:7},'3 fixed + 1 chosen base, 3 lemon, dispatched once')
 const changed=await call(Sales.create,{...req(),body:{...structuredClone(body),packages:[f.selection(2,2)]}}).catch(e=>e)
 assert.equal(changed.status??changed.statusCode,409,'the same key with another package is not treated as the same sale')
 assert.deepEqual(await f.available(),{base:6,lemon:7})
})
