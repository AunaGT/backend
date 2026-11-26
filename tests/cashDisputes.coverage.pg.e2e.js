// Regresiones de la revisión final: el principal perdido sin retiro y la devolución de una venta directa no se pagan dos veces.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema,fixture}=require('./helpers/cashDisputesQa.cjs')
const {run,lostCase}=require('./helpers/cashDisputesFlow.cjs')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL
const flow=require('../src/modules/cash-closure/disputes'),queries=require('../src/modules/cash-closure/disputes.queries')

test('a lost result the bank has not debited yet keeps its principal out of every other claim',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db,{applied:'100',withdraw:false})
  assert.equal(doc.status,'LOST');assert.equal(doc.withdrawn,'0.00')
  assert.equal((await queries.originContext(db,f.scope,f.event.id)).claimable,'0.00','the bank still owes the debit of the lost principal')
  const [{used}]=await db.$queryRaw`SELECT cash_dispute_origin_used(${f.event.id}::uuid)::text AS used`
  assert.equal(used,'100.00','the database budget agrees with the service')
  await assert.rejects(run(db,tx=>flow.createDispute(tx,f.scope,{eventId:f.event.id,claimed:'1',providerReference:randomUUID(),reason:'Segundo reclamo',requestKey:randomUUID()})),e=>['DISPUTE_COVERAGE_EXCEEDED','DISPUTE_ORIGIN_BLOCKED'].includes(e.code))
 }finally{await db.$disconnect()}
})

async function directBankSale(db,f){
 const category=await db.productCategory.create({data:{company_id:f.company.id,name:'Servicios QA'}})
 const status=await db.stockStatus.upsert({where:{name:'Disponible QA'},create:{name:'Disponible QA'},update:{}})
 const product=await db.product.create({data:{company_id:f.company.id,category_id:category.id,status_id:status.id,name:'Servicio QA',kind:'SERVICE',service_unit_label:'Servicio',quantity_decimals:2,price:100,cost:0}})
 const completed=await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
 const sale=await run(db,async tx=>{
  const sale=await tx.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:completed.id,payment_method_id:f.card.id,total:100,adjusted_total:100,items:1,payment_status:'PAID',created_by:f.user.id,cash_register_session_id:f.period.id,
   sale_items:{create:{product_id:product.id,price:100,net_total:100,qty:1,item_name:product.name,item_kind:'SERVICE',unit_label:'Servicio',quantity_decimals:2}}},include:{sale_items:true}})
  const session=await require('../src/services/cashSessionBoundary').lockScopedSession(tx,f.scope,f.period.id)
  await require('../src/modules/cash-closure/events').recordMoneyEvent(tx,f.scope,{session,sourceType:'SALE',sourceId:sale.id})
  return sale
 })
 const [origin]=await db.$queryRaw`SELECT id FROM cash_money_events WHERE source_type='SALE' AND source_id=${sale.id}::uuid`
 return {sale,product,origin}
}

test('refunding a direct card sale cannot spend the principal an open claim still holds',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const f=await fixture(db),{sale,product,origin}=await directBankSale(db,f)
  await run(db,tx=>flow.createDispute(tx,f.scope,{eventId:origin.id,claimed:'100',providerReference:randomUUID(),reason:'Contracargo de venta directa',requestKey:randomUUID()}))
  const approved=await db.returnStatus.upsert({where:{name:'Aprobada'},create:{name:'Aprobada'},update:{}})
  await db.returnStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
  const returned=await db.return.create({data:{reference:'QA-'+randomUUID().slice(0,12),sale_id:sale.id,status_id:approved.id,total_refund:100,approved_resolution:'REFUND_ORIGINAL',
   return_items:{create:{sale_item_id:sale.sale_items[0].id,product_id:product.id,qty_returned:'1',refund_amount:100}}},include:{return_items:true}})
  const before=await db.returnSettlement.count()
  await assert.rejects(require('../src/modules/returns/application').completeReturn(db,{id:returned.id,scope:{branch_id:f.branch.id,branch:{company_id:f.company.id}},companyId:f.company.id,userId:f.user.id,permissions:['returns.complete'],
   payload:{idempotency_key:randomUUID(),lines:[{return_item_id:returned.return_items[0].id}]}}),
   e=>(e.status===409&&e.code==='DISPUTE_REFUND_RESTRICTED')||/dispute_coverage/.test(e.message),'the same principal cannot go back to the customer through the store and the chargeback')
  assert.equal(await db.returnSettlement.count(),before,'nothing is committed')
  // Defensa en la base: un escritor antiguo que inserte la devolución directamente también se rechaza al confirmar.
  await assert.rejects(run(db,tx=>tx.returnSettlement.create({data:{return_id:returned.id,kind:'REFUND',amount:'100',registered_by:f.user.id,idempotency_key:randomUUID()}})),/dispute_coverage/)
 }finally{await db.$disconnect()}
})
