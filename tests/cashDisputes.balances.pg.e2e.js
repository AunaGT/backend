const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {qaSchema}=require('./helpers/cashDisputesQa.cjs')
const {run,act,lostCase}=require('./helpers/cashDisputesFlow.cjs')
const receivables=require('../src/modules/receivables'),Charges=require('../src/modules/receivables/domain/chargeDocuments')
const url=process.env.AUNA_CASH_DISPUTES_QA_URL

// Cargo Q60 por contracargo, venta al crédito pendiente Q50 y un anticipo libre de Q10.
async function scenario(db){
 const {f,doc}=await lostCase(db,{applied:'100'})
 const pay=(amount,extra={})=>run(db,tx=>receivables.applyPayment(tx,{...f.scope,customerId:f.customer.id,amount,paymentMethodId:f.card.id,cashRegisterSessionId:f.period.id,allowAdvance:true,...extra}))
 const advance=await pay(10)
 await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'60',absorbedPrincipal:'40',dueOn:'2026-12-31',reason:'Reparto acordado'})).decide()
 const [charge]=await db.$queryRaw`SELECT id FROM customer_dispute_charges WHERE dispute_id=${doc.id}::uuid`
 const status=await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
 const method=await db.paymentMethod.create({data:{company_id:f.company.id,name:'Crédito saldo QA',is_credit:true}})
 const sale=await db.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:status.id,payment_method_id:method.id,total:50,adjusted_total:50,items:0,created_by:f.user.id,payment_status:'PENDING',due_date:new Date('2027-12-31T23:59:59Z'),date:new Date('2026-11-25T12:00:00Z')}})
 return {f,doc,charge,sale,pay,advance}
}
const balance=(db,f,now)=>receivables.customerBalance(db,f.customer.id,{branch_id:f.branch.id},now)

test('a dispute charge is a separate receivable document in every balance and blocks credit once overdue',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await scenario(db)
  const lots=(await require('../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,doc.id)).lots
  const decided=(await require('../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,doc.id)).proposals.find(p=>p.kind==='DISPOSITION')
  assert.deepEqual([decided.payload.planRetired,decided.payload.planCharged,decided.payload.planAbsorbed,decided.payload.dueOn],['0.00','60.00','40.00','2026-12-31'],'the reviewer sees the exact effect, not only the requested split')
  assert.deepEqual(lots.map(l=>[l.kind,l.remaining,l.outstanding,!!l.chargeReference]).sort(),[['ABSORBED','40.00',null,false],['CUSTOMER_CHARGE','60.00','60.00',true]],'the case lists its live resolutions with the charge still owed')
  const b=await balance(db,f,new Date('2026-12-01T12:00:00Z'))
  assert.equal(b.saldo,110);assert.equal(b.saldo_neto,100);assert.equal(b.credito_disponible,10)
  assert.equal(b.facturas_abiertas,1);assert.equal(b.cargos_abiertos,1);assert.equal(b.documentos_abiertos,2)
  assert.equal(b.cargos_vencidos,0)
  const customer={id:f.customer.id,credit_limit:null},later=new Date('2027-01-05T12:00:00Z')
  const check=await receivables.checkCredit(db,customer,10,{branch_id:f.branch.id},later)
  assert.equal(check.ok,false,'an overdue charge blocks credit even with no overdue invoice');assert.equal(check.facturas_vencidas,0);assert.equal(check.cargos_vencidos,1)
  assert.match(check.motivo,/cargo/)
  assert.equal((await balance(db,f,later)).vencido,60)
  const statement=await Charges.chargeStatementOf(db,f.customer.id,{branch_id:f.branch.id},later)
  assert.deepEqual(statement.cargos.map(c=>[c.tipo,c.total,c.saldo,c.vencido]),[['CARGO_CONTRACARGO',60,60,true]])
  const list=(state,now)=>Charges.chargeInvoices(db,f.company.id,{branchIds:[f.branch.id],state,now,take:10})
  assert.deepEqual((await list('ALL',later)).items.map(i=>[i.documentType,i.saldo,i.customer_id]),[['DISPUTE_CHARGE',60,f.customer.id]])
  assert.equal((await list('OVERDUE',new Date('2026-12-01T12:00:00Z'))).total,0,'not overdue before its due day ends')
  assert.equal((await list('OVERDUE',later)).total,1)
 }finally{await db.$disconnect()}
})

test('one receipt pays the charge and the sale in due order and keeps its history',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,charge,sale,pay}=await scenario(db)
  const result=await pay(110,{allowAdvance:false})
  assert.deepEqual(result.applications.map(a=>[a.documentType??'SALE',a.amount]),[['DISPUTE_CHARGE',60],['SALE',50]],'the charge due first is covered first')
  assert.equal(result.unapplied,0)
  const b=await balance(db,f,new Date('2026-12-01T12:00:00Z'))
  assert.equal(b.saldo,0);assert.equal(b.cargos_abiertos,0);assert.equal(b.facturas_abiertas,0)
  assert.equal((await db.sale.findUnique({where:{id:sale.id}})).payment_status,'PAID')
  assert.equal((await Charges.chargeApplicationsOfReceipts(db,[result.paymentId])).get(result.paymentId)[0].charge_id,charge.id)
  assert.equal(await Charges.receiptDisputeDependency(db,result.paymentId),true,'a receipt that paid a charge keeps its history')
  await assert.rejects(pay(1,{allowAdvance:false,manualApplications:[{documentType:'DISPUTE_CHARGE',documentId:charge.id,amount:1}]}),/ya no tiene saldo/)
 }finally{await db.$disconnect()}
})

test('available credit is applied to the dispute charge as well as sales, without a second receipt',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,charge,advance}=await scenario(db)
  const receipts=await db.customerPayment.count()
  const applied=await run(db,tx=>receivables.applyAvailableCredit(tx,f.customer.id,f.branch.id,{companyId:f.company.id,userId:f.user.id}))
  assert.deepEqual(applied.map(a=>[a.documentId??a.sale_id,a.payment_id,a.amount]),[[charge.id,advance.paymentId,10]],'the earliest due document receives the advance')
  assert.equal(await db.customerPayment.count(),receipts,'no synthetic receipt is created')
  const b=await balance(db,f,new Date('2026-12-01T12:00:00Z'))
  assert.equal(b.saldo,100);assert.equal(b.credito_disponible,0)
 }finally{await db.$disconnect()}
})

test('the payment attempt hash keeps old sale-only payloads identical and distinguishes charges',{skip:!url},()=>{
 const {paymentHash}=require('../src/modules/receivables/paymentAttempts')
 const base={customer_id:'c',amount:'10',payment_method_id:1,request_key:randomUUID()}
 assert.equal(paymentHash({...base,applications:[{sale_id:'s',amount:'10'}]}),paymentHash({...base,applications:[{documentType:'SALE',documentId:'s',amount:'10'}]}))
 assert.notEqual(paymentHash({...base,applications:[{sale_id:'s',amount:'10'}]}),paymentHash({...base,applications:[{documentType:'DISPUTE_CHARGE',documentId:'s',amount:'10'}]}))
})

test('the cash day shows its dispute movements and issued charges as a later query, outside the snapshot and the cash',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db,{applied:'100'})
  await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'60',absorbedPrincipal:'40',dueOn:'2026-12-31',reason:'Reparto acordado'})).decide()
  const [charge]=await db.$queryRaw`SELECT issued_on::text AS day FROM customer_dispute_charges WHERE dispute_id=${doc.id}::uuid`
  const daily=require('../src/modules/cash-closure/dailyConsolidation'),staff={...f.scope,canRead:true,canFinalize:false}
  const withdrawal=await daily.dayView(db,staff,'2026-11-24')
  assert.equal(withdrawal.current.disputes.withdrawn,'100.00');assert.equal(withdrawal.current.disputes.items[0].disputeId,doc.id)
  assert.equal(JSON.stringify(withdrawal.snapshot).includes(doc.id),false,'the dispute never enters the day snapshot')
  const issued=await daily.dayView(db,staff,charge.day)
  assert.deepEqual(issued.current.disputes.chargesIssued,{count:1,amount:'60.00'})
 }finally{await db.$disconnect()}
})

test('the dispute report keeps claimed, withdrawn, recovered, loss, charge and credit as separate amounts',{skip:!url,timeout:240000},async()=>{
 const {db}=await qaSchema(url)
 try{
  const {f,doc}=await lostCase(db,{applied:'100'})
  await (await act(db,f,doc.id,'DISPOSITION',{customerPrincipal:'60',absorbedPrincipal:'40',dueOn:'2026-12-31',reason:'Reparto acordado'})).decide()
  const rows=await require('../src/modules/cash-closure/disputes.report').disputeReportRows(db,{companyId:f.company.id,branchIds:[f.branch.id]})
  assert.deepEqual(rows.map(r=>[r.status,r.claimed,r.withdrawn,r.recovered,r.loss,r.charged,r.credited]),[['LOST',100,100,0,40,60,0]])
  assert.deepEqual(await require('../src/modules/cash-closure/disputes.report').disputeReportRows(db,{companyId:f.company.id,branchIds:[f.branch.id],start:'2099-01-01T00:00:00Z'}),[])
 }finally{await db.$disconnect()}
})
