// Opt-in only: same authorized development DB, synthetic UUID scopes, no role changes.
require('../src/config/loadEnv')
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {PrismaClient}=require('@prisma/client'),Units=require('../src/modules/inventory/units')
const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
const {resolveCommercialLines}=require('../src/services/units/saleLines')
const {createSaleRecordAndStock}=require('../src/modules/sales/application')
const {approveReturn,completeApprovedReturn}=require('../src/modules/returns/application')
const {normalizeReturnLines,refundFromLine}=require('../src/modules/returns/domain')
const {deductStockMap,restoreStockMap}=require('../src/services/bomStock')
const {consumeLotsFEFO}=require('../src/services/lots')
const {dispatchedByRef}=require('../src/services/stockLocations')
const enabled=process.env.RUN_UNITS_DEV_E2E==='1'
const {connectionIdentity}=require('../scripts/salesDevTarget')
if(enabled){
 assert.ok(process.env.AUNA_UNITS_DEV_IDENTITY,'The previously verified development target identity is required')
 assert.equal(connectionIdentity(process.env.DIRECT_URL),process.env.AUNA_UNITS_DEV_IDENTITY)
 assert.equal(new URL(process.env.DIRECT_URL).searchParams.get('schema')||'public','public')
}
const db=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL||process.env.DATABASE_URL}}})
const ownerIds=[]
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const ledgerDirectory=enabled?fs.mkdtempSync(path.join(os.tmpdir(),'auna-units-qa-')):null
if(ledgerDirectory)fs.chmodSync(ledgerDirectory,0o700)
const saveLedger=()=>{if(ledgerDirectory)fs.writeFileSync(path.join(ledgerDirectory,'ledger.json'),JSON.stringify({ownerIds,identity:process.env.AUNA_UNITS_DEV_IDENTITY}),{mode:0o600})}
test.after(async()=>{try{for(const id of ownerIds)assert.equal(await db.company.count({where:{id}}),0,'Owned synthetic company remains');if(enabled)console.log('Owned synthetic companies absent:',ownerIds.length)}finally{await db.$disconnect()}})

async function fixture(tx,{advanced=false,measured=false}={}){
 const id=randomUUID();ownerIds.push(id);saveLedger()
 const actor=await tx.user.findFirst({select:{id:true}}),status=await tx.stockStatus.findFirst({select:{id:true}}),saleStatus=await tx.saleStatus.findFirst({where:{name:'Completada'},select:{id:true}}),cash=await tx.paymentMethod.findFirst({where:{company_id:null,settlement_kind:'CASH',is_credit:false},select:{id:true}})
 assert.ok(actor&&status&&saleStatus&&cash,'Existing development reference catalogs required')
 await tx.company.create({data:{id,name:'QA unidades UUID temporal',code:'uq-'+id.slice(0,12)}})
 await Units.seedStandardUnits(tx,id)
 const branch=await tx.branch.create({data:{company_id:id,name:'QA UUID',code:'UQA'}})
 const warehouse=await tx.warehouse.create({data:{branch_id:branch.id,name:'QA UUID',code:'QA',is_default:true,is_receiving:true}})
 const location=await tx.stockLocation.create({data:{warehouse_id:warehouse.id,code:'A',is_default:true,dispatch_priority:1}})
 const otherLocation=await tx.stockLocation.create({data:{warehouse_id:warehouse.id,code:'B',dispatch_priority:2}})
 const supplier=await tx.supplier.create({data:{company_id:id,name:'QA proveedor UUID',contact:'QA'}})
 const category=await tx.productCategory.create({data:{company_id:id,name:'QA UUID'}})
 await tx.systemSetting.createMany({data:[{company_id:id,key:'inventory_units_enabled',value:advanced?'true':'false',type:'string'},{company_id:id,key:'timezone',value:'America/Guatemala',type:'string'}]})
 await tx.companyPaymentMethod.create({data:{company_id:id,payment_method_id:cash.id,enabled:true}})
 const register=await tx.cashRegister.create({data:{branch_id:branch.id,name:'QA caja UUID',code:'QA',is_default:true}})
 const session=await tx.cashRegisterSession.create({data:{cash_register_id:register.id,opened_by_id:actor.id,opening_float:'0'}})
 const base=await tx.measureUnit.findUnique({where:{company_id_code:{company_id:id,code:measured?'KG':'UNIT'}}})
 const product=await tx.product.create({data:{company_id:id,name:'QA producto UUID',category_id:category.id,status_id:status.id,supplier_id:supplier.id,base_unit_id:base.id,unit_metadata_version:advanced?2:1,quantity_decimals:measured?6:0,price:'7',cost:'0',tracks_expiry:false}})
 await tx.productStock.create({data:{product_id:product.id,branch_id:branch.id,stock:'0',min_stock:'0'}})
 const scope={companyId:id,branchId:branch.id,actorId:actor.id,permissions:['products.register_incoming','products.view','products.edit','sales.create','returns.manage']}
 const req={companyId:id,branchId:branch.id,user:{sub:actor.id,permissions:scope.permissions}}
 return {id,actor:actor.id,branch:branch.id,location:location.id,otherLocation:otherLocation.id,supplier:supplier.id,product,scope,req,cash:cash.id,session:session.id,saleStatus:saleStatus.id}
}
async function purchase(client,f,items,{key=randomUUID(),initial=false}={}){
 let output
 await withMocks({[require.resolve('../src/models/prisma')]:{prisma:client,prismaTransaction:client}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
  const response=jsonResponse()
  await controller.registerIncomingMerchandise({...f.req,body:{supplier_id:f.supplier,location_id:f.location,...(initial?{is_initial_load:true}:{}),request_key:key,items}},response,e=>{throw e})
  assert.equal(response.statusCode,200);output=response.body
 })
 return output
}
async function rollbackCase(fn){
 const rollback=Error('OWNED_QA_ROLLBACK')
 await assert.rejects(db.$transaction(async tx=>{const client=new Proxy(tx,{get:(target,key)=>key==='$transaction'?async run=>run(client):Reflect.get(target,key)})
  await fn(tx,client);throw rollback
 },{timeout:180000,maxWait:15000}),e=>e===rollback)
}
async function sell(tx,f,raw){
 const lines=await resolveCommercialLines(tx,f.scope,raw)
 await require('../src/services/stockAvailability').assertLinesAvailable(tx,lines,{companyId:f.id,branchId:f.branch})
 const total=lines.reduce((sum,l)=>sum.add(l.line_total),new (require('@prisma/client').Prisma.Decimal)(0)).toFixed(2)
 const sale=await createSaleRecordAndStock(tx,{companyId:f.id,userId:f.actor,items:lines,saleData:{branch_id:f.branch,status_id:f.saleStatus,payment_method_id:f.cash,cash_register_session_id:f.session,total,adjusted_total:total,subtotal:total,discount_total:'0',items:lines.length,unit_metadata_version:lines.some(l=>l.unit_metadata_version===2)?2:1}})
 return tx.sale.findUnique({where:{id:sale.id},include:{sale_items:true}})
}
async function returnOne(tx,f,sale,{index=0,quarantine=false}={}){
 const original=sale.sale_items[index],raw={sale_item_id:original.id,product_id:original.product_id,qty_returned:'1',...(original.unit_metadata_version===2?{presentation_id:null}:{})}
 const [line]=normalizeReturnLines([raw],sale.sale_items)
 const amount=refundFromLine({originalQty:original.unit_metadata_version===2?original.base_qty:original.qty,lineNet:original.net_total,qty:'1'}).toFixed(2)
 const pending=await tx.returnStatus.findFirst({where:{name:'Pendiente'}})
 const record=await tx.return.create({data:{sale_id:sale.id,status_id:pending.id,total_refund:amount,items_count:1,unit_metadata_version:original.unit_metadata_version,requested_resolution:'REFUND_ORIGINAL',return_items:{create:[{...line,refund_amount:amount}]}} ,include:{return_items:true}})
 const scope={branch_id:f.branch,branch:{company_id:f.id}}
 await approveReturn(tx,{id:record.id,scope,userId:f.actor,companyId:f.id,resolution:'REFUND_ORIGINAL',lines:[{return_item_id:record.return_items[0].id,disposition:quarantine?'QUARANTINE':'SELLABLE',stock_location_id:f.location}]})
 const payload={idempotency_key:randomUUID(),lines:[{return_item_id:record.return_items[0].id,received_qty:'1',disposition:quarantine?'QUARANTINE':'SELLABLE',stock_location_id:f.location}],settlement:{cash_register_session_id:f.session,payment_method_id:f.cash}}
 const result=await completeApprovedReturn(tx,{id:record.id,scope,userId:f.actor,companyId:f.id,payload})
 await completeApprovedReturn(tx,{id:record.id,scope,userId:f.actor,companyId:f.id,payload})
 assert.equal(await tx.returnSettlement.count({where:{return_id:record.id}}),1)
 return result
}

test('real legacy UNIT purchase/sale/return retains factor1, money and stock with flag off',{skip:!enabled},async()=>rollbackCase(async(tx,client)=>{
 const f=await fixture(tx)
 await purchase(client,f,[{product_id:f.product.id,quantity:2,unit_cost:5}])
 const sale=await sell(tx,f,[{product_id:f.product.id,qty:1}])
 assert.equal(String(sale.total),'7');assert.equal(sale.sale_items[0].unit_metadata_version,1)
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'1')
 await returnOne(tx,f,sale)
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'2')
 assert.equal(String((await tx.sale.findUnique({where:{id:sale.id}})).total_returned),'7')
}))
test('real box24 purchase, mixed-presentation sale and base return preserve cents and snapshots',{skip:!enabled},async()=>rollbackCase(async(tx,client)=>{
 const f=await fixture(tx,{advanced:true})
 const box=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:1,name:'Caja24',label:'caja',factor:'24',quantity_decimals:0})
 const pack=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:2,name:'Paquete6',label:'paq',factor:'6',quantity_decimals:0,prices:{LIST:'36'}})
 const item={product_id:f.product.id,quantity:'2',unit_cost:'120',presentation_id:box.id,unit_revision:3}
 const first=await purchase(client,f,[item],{key:'same-purchase'})
 assert.equal(first.totalPurchaseValue,'240.00');assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'48')
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).cost),'5')
 await purchase(client,f,[item],{key:'same-purchase'});assert.equal(await tx.incomingMerchandise.count({where:{branch_id:f.branch}}),1)
 const sale=await sell(tx,f,[{product_id:f.product.id,qty:'1',presentation_id:pack.id,unit_revision:3},{product_id:f.product.id,qty:'3',presentation_id:null,unit_revision:3}])
 assert.equal(String(sale.total),'57');assert.equal(sale.sale_items.length,2)
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'39')
 await returnOne(tx,f,sale,{index:sale.sale_items.findIndex(line=>line.unit_snapshot?.presentation?.id===pack.id)})
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'40')
 assert.equal(String((await tx.sale.findUnique({where:{id:sale.id}})).total_returned),'6')
 await assert.rejects(Units.resolveUnitLine(tx,{...f.scope,companyId:randomUUID()},f.product,{qty:'1',unit_revision:3}),e=>e.status===404)
}))
test('real measured FEFO uses exact base across two locations and permits an unlotted remainder',{skip:!enabled},async()=>rollbackCase(async(tx)=>{
 const f=await fixture(tx,{advanced:true,measured:true})
 await restoreStockMap(tx,new Map([[f.product.id,'0.25']]),f.branch,{reason:'INITIAL',locationId:f.location,userId:f.actor})
 await restoreStockMap(tx,new Map([[f.product.id,'1.75']]),f.branch,{reason:'INITIAL',locationId:f.otherLocation,userId:f.actor})
 const early=await tx.productLot.create({data:{product_id:f.product.id,branch_id:f.branch,location_id:f.location,lot_code:'QA-E',expiry_date:new Date('2097-01-01'),qty_received:'0.25',qty_remaining:'0.25',unit_cost:'2'}})
 const late=await tx.productLot.create({data:{product_id:f.product.id,branch_id:f.branch,location_id:f.otherLocation,lot_code:'QA-L',expiry_date:new Date('2098-01-01'),qty_received:'0.5',qty_remaining:'0.5',unit_cost:'2'}})
 const groupId=randomUUID(),quantities=new Map([[f.product.id,'0.6']])
 await deductStockMap(tx,quantities,f.branch,{reason:'SALE',refType:'units_qa',refId:randomUUID(),groupId,userId:f.actor})
 await consumeLotsFEFO(tx,quantities,f.branch,await dispatchedByRef(tx,{groupId}))
 assert.equal(String((await tx.productLot.findUnique({where:{id:early.id}})).qty_remaining),'0')
 assert.equal(String((await tx.productLot.findUnique({where:{id:late.id}})).qty_remaining),'0.15')
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'1.4')
}))

test('real box7 partial deliveries and invoices preserve seven base units and ten currency units',{skip:!enabled},async()=>rollbackCase(async(tx,client)=>{
 const f=await fixture(tx,{advanced:true})
 const box=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:1,name:'Caja7',label:'caja',factor:'7',quantity_decimals:0,prices:{LIST:'10'}})
 await purchase(client,f,[{product_id:f.product.id,quantity:'1',unit_cost:'7',presentation_id:box.id,unit_revision:2}])
 const [resolved]=await resolveCommercialLines(tx,f.scope,[{product_id:f.product.id,qty:'1',presentation_id:box.id,unit_revision:2}])
 const {unit_cost,...line}=resolved
 const order=await tx.commercialDocument.create({data:{branch_id:f.branch,doc_type:'ORDER',status:'CONFIRMED',fulfillment_mode:'SEPARATE',unit_metadata_version:2,total:'10',subtotal:'10',discount_total:'0',created_by:f.actor,lines:{create:[{...line,base_fulfilled:'0',base_invoiced:'0'}]}},include:{lines:true}})
 await require('../src/services/stockAvailability').reserveForDocument(tx,{documentId:order.id,documentLines:order.lines,branchId:f.branch,companyId:f.id,createdBy:f.actor})
 const {deliver,invoice}=require('../src/modules/orders/fulfillment')
 const req={...f.req,params:{id:order.id},body:{request_key:randomUUID(),lines:[{line_id:order.lines[0].id,qty:'3',presentation_id:null}]}}
 await deliver(tx,req);await deliver(tx,req)
 req.body={request_key:randomUUID(),lines:[{line_id:order.lines[0].id,qty:'4',presentation_id:null}]}
 await deliver(tx,req)
 assert.equal(await tx.orderDelivery.count({where:{document_id:order.id}}),2)
 const cashSession=async(tx,user,register,branch)=>{
  const session=await tx.cashRegisterSession.findFirst({where:{id:f.session,status:'OPEN',opened_by_id:user.sub,cashRegister:{branch_id:branch,active:true}}});assert.ok(session);return session.id
 }
 const totals=[]
 for(const qty of ['3','4']){
  req.body={request_key:randomUUID(),payment_method_id:f.cash,lines:[{line_id:order.lines[0].id,qty,presentation_id:null}]}
  const result=await invoice(tx,req,cashSession);totals.push(String(result.sale.total));await invoice(tx,req,cashSession)
 }
 assert.deepEqual(totals,['4.29','5.71'])
 assert.equal(await tx.sale.count({where:{branch_id:f.branch}}),2)
 const saved=await tx.commercialDocumentLine.findUnique({where:{id:order.lines[0].id}})
 assert.equal(String(saved.base_qty),'7');assert.equal(String(saved.base_fulfilled),'7');assert.equal(String(saved.base_invoiced),'7')
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'0')
 assert.equal(await tx.stockReservation.count({where:{document_id:order.id,status:'ACTIVE'}}),0)
 await tx.$executeRawUnsafe('SAVEPOINT unit_base_bounds')
 await assert.rejects(()=>tx.$executeRaw`UPDATE commercial_document_lines SET base_fulfilled=8 WHERE id=${saved.id}::uuid`,e=>e.meta?.code==='23514')
 await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT unit_base_bounds')
 await tx.$executeRawUnsafe('RELEASE SAVEPOINT unit_base_bounds')
}))

test('real SQL rejects invalid unit metadata and cross-company references; measured rounding is explicit',{skip:!enabled},async()=>rollbackCase(async(tx)=>{
 const f=await fixture(tx,{advanced:true,measured:true})
 const box=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:1,name:'Libra',label:'lb',factor:'0.45359237',quantity_decimals:0})
 await assert.rejects(Units.resolveUnitLine(tx,f.scope,f.product,{qty:'1',presentation_id:box.id,unit_revision:2}),e=>e.status===400)
 const accepted=await Units.resolveUnitLine(tx,f.scope,f.product,{qty:'1',presentation_id:box.id,unit_revision:2,accept_rounding:true})
 assert.equal(accepted.base_qty,'0.453592');assert.equal(accepted.unit_snapshot.roundingDelta,'-0.00000037')
 const other=await tx.measureUnit.findFirst({where:{company_id:{not:f.id},code:'UNIT'},select:{id:true}});assert.ok(other)
 const rejects=[
  [()=>tx.$executeRaw`UPDATE products SET unit_metadata_version=3 WHERE id=${f.product.id}::uuid`,'23514'],
  [()=>tx.$executeRaw`UPDATE product_presentations SET factor=0 WHERE id=${box.id}::uuid`,'23514'],
  [()=>tx.$executeRaw`UPDATE products SET base_unit_id=${other.id}::uuid WHERE id=${f.product.id}::uuid`,'23503'],
 ]
 const legacy=await tx.commercialDocument.create({data:{branch_id:f.branch,doc_type:'ORDER',total:'14',lines:{create:[{product_id:f.product.id,item_name:'QA legacy UNIT',item_kind:'STANDARD',unit_label:'unidad',quantity_decimals:0,qty:'2',unit_price:'7',line_total:'14'}]}},include:{lines:true}})
 rejects.push([()=>tx.$executeRaw`UPDATE commercial_document_lines SET qty_fulfilled=0.5 WHERE id=${legacy.lines[0].id}::uuid`,'23514'])
 for(const [run,code]of rejects){await tx.$executeRawUnsafe('SAVEPOINT unit_constraint_check');await assert.rejects(run,e=>e.code==='P2010'&&e.meta?.code===code);await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT unit_constraint_check');await tx.$executeRawUnsafe('RELEASE SAVEPOINT unit_constraint_check')}
 assert.equal((await tx.product.findUnique({where:{id:f.product.id}})).unit_metadata_version,2)
}))

test('real measured sack25 purchase then gram and kg sales leave exactly23.25kg',{skip:!enabled},async()=>rollbackCase(async(tx,client)=>{
 const f=await fixture(tx,{advanced:true,measured:true})
 const sack=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:1,name:'Saco25',label:'saco',factor:'25',quantity_decimals:0})
 const grams=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:2,name:'Gramo',label:'g',factor:'0.001',quantity_decimals:0})
 await purchase(client,f,[{product_id:f.product.id,quantity:'1',unit_cost:'100',presentation_id:sack.id,unit_revision:3}])
 const sale=await sell(tx,f,[{product_id:f.product.id,qty:'500',presentation_id:grams.id,unit_revision:3},{product_id:f.product.id,qty:'1.25',presentation_id:null,unit_revision:3}])
 assert.deepEqual(sale.sale_items.map(line=>String(line.base_qty)).sort(),['0.5','1.25'])
 assert.equal(String(sale.total),'12.25')
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'23.25')
 assert.equal(String((await tx.productStock.findUnique({where:{product_id_branch_id:{product_id:f.product.id,branch_id:f.branch}}})).stock),'23.25')
 assert.equal(String((await tx.productStockLocation.findUnique({where:{product_id_location_id:{product_id:f.product.id,location_id:f.location}}})).stock),'23.25')
}))

test('real box7 initial stock creates no operative payable and one base return refunds1.43',{skip:!enabled},async()=>rollbackCase(async(tx,client)=>{
 const f=await fixture(tx,{advanced:true})
 const box=await Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:1,name:'Caja7',label:'caja',factor:'7',quantity_decimals:0,prices:{LIST:'10'}})
 const incoming=await purchase(client,f,[{product_id:f.product.id,quantity:'1',unit_cost:'7',presentation_id:box.id,unit_revision:2}],{initial:true})
 const stored=await tx.incomingMerchandise.findUnique({where:{id:incoming.incomingMerchandise.id},include:{items:true}})
 assert.equal(stored.source,'INITIAL')
 assert.equal(require('../src/modules/merchandise/payables/balance').balanceOf(stored).excluded,true)
 assert.equal(String((await tx.supplier.findUnique({where:{id:f.supplier}})).total_purchases),'0')
 assert.equal(await tx.supplierPayment.count({where:{company_id:f.id}}),0)
 const sale=await sell(tx,f,[{product_id:f.product.id,qty:'1',presentation_id:box.id,unit_revision:2}])
 await returnOne(tx,f,sale)
 assert.equal(String((await tx.sale.findUnique({where:{id:sale.id}})).total_returned),'1.43')
 const original=await tx.saleItem.findUnique({where:{id:sale.sale_items[0].id}})
 assert.equal(String(original.base_returned),'1')
 assert.equal(String((await tx.product.findUnique({where:{id:f.product.id}})).stock),'1')
}))

async function cleanup(f){
 await db.$transaction(async tx=>{
  assert.ok(ownerIds.includes(f.id));const products={company_id:f.id}
  await tx.alert.deleteMany({where:{branch_id:f.branch}})
  await tx.stockMovement.deleteMany({where:{product:products}})
  await tx.saleItem.deleteMany({where:{sale:{branch_id:f.branch}}})
  await tx.sale.deleteMany({where:{branch_id:f.branch}})
  await tx.productLot.deleteMany({where:{product:products}})
  await tx.incomingMerchandiseItem.deleteMany({where:{incomingMerchandise:{branch_id:f.branch}}})
  await tx.purchaseLog.deleteMany({where:{product:products}})
  await tx.incomingMerchandise.deleteMany({where:{branch_id:f.branch}})
  await tx.productBarcode.deleteMany({where:{company_id:f.id}})
  await tx.product.updateMany({where:products,data:{default_purchase_presentation_id:null,default_sale_presentation_id:null}})
  await tx.productPresentation.deleteMany({where:{company_id:f.id}})
  await tx.productStockLocation.deleteMany({where:{product:products}})
  await tx.productStock.deleteMany({where:{product:products}})
  await tx.product.deleteMany({where:products})
  await tx.measureUnit.deleteMany({where:{company_id:f.id}})
  await tx.systemSetting.deleteMany({where:{company_id:f.id}})
  await tx.settingAuditEvent.deleteMany({where:{company_id:f.id}})
  await tx.companyPaymentMethod.deleteMany({where:{company_id:f.id}})
  await tx.cashRegisterSession.deleteMany({where:{cashRegister:{branch_id:f.branch}}})
  await tx.cashRegister.deleteMany({where:{branch_id:f.branch}})
  await tx.supplier.deleteMany({where:{company_id:f.id}})
  await tx.productCategory.deleteMany({where:{company_id:f.id}})
  await tx.stockLocation.deleteMany({where:{warehouse:{branch_id:f.branch}}})
  await tx.warehouse.deleteMany({where:{branch_id:f.branch}})
  await tx.branch.deleteMany({where:{company_id:f.id}})
  await tx.company.delete({where:{id:f.id}})
 },{timeout:120000,maxWait:15000})
}
test('real concurrent purchase/replay preserves average once and concurrent stock cannot oversell',{skip:!enabled},async()=>{
 let f
 try{
  f=await db.$transaction(tx=>fixture(tx,{advanced:true}),{timeout:60000,maxWait:15000})
  await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db,prismaTransaction:db}},require.resolve('../src/modules/inventory/products.controller'),async controller=>{
   const buy=async(key,cost)=>{const response=jsonResponse();await controller.registerIncomingMerchandise({...f.req,body:{supplier_id:f.supplier,location_id:f.location,request_key:key,items:[{product_id:f.product.id,quantity:'1',unit_cost:cost,presentation_id:null,unit_revision:1}]}},response,e=>{throw e});assert.equal(response.statusCode,200);return response.body}
   await Promise.all([buy('concurrent-A','5'),buy('concurrent-B','7')])
   await Promise.all([buy('concurrent-A','5'),buy('concurrent-A','5')])
  })
  const product=await db.product.findUnique({where:{id:f.product.id}})
  assert.equal(String(product.stock),'2');assert.equal(String(product.cost),'6')
  assert.equal(await db.incomingMerchandise.count({where:{branch_id:f.branch}}),2)
  assert.equal(String((await db.supplier.findUnique({where:{id:f.supplier}})).total_purchases),'12')
  const box=await db.$transaction(tx=>Units.savePresentation(tx,f.scope,f.product.id,{unit_revision:1,name:'Caja2',label:'caja',factor:'2',quantity_decimals:0}),{timeout:30000,maxWait:15000})
  const move=raw=>db.$transaction(tx=>sell(tx,f,[raw]),{timeout:30000,maxWait:15000})
  const results=await Promise.allSettled([
   move({product_id:f.product.id,qty:'1',presentation_id:box.id,unit_revision:2}),
   move({product_id:f.product.id,qty:'2',presentation_id:null,unit_revision:2}),
  ])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.filter(r=>r.status==='rejected').length,1)
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'INSUFFICIENT_STOCK')
  assert.equal(await db.sale.count({where:{branch_id:f.branch}}),1)
  assert.equal(String((await db.product.findUnique({where:{id:f.product.id}})).stock),'0')
 }finally{if(f)await cleanup(f)}
})
