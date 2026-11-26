// Flujo común de disputas para pruebas PG: expediente perdido, propuestas y movimientos.
const {randomUUID}=require('node:crypto')
const {fixture}=require('./cashDisputesQa.cjs')
const flow=require('../../src/modules/cash-closure/disputes')
const run=(db,fn)=>db.$transaction(fn,{timeout:20000})
const effect=(db,f,id,raw)=>run(db,tx=>require('../../src/modules/cash-closure/disputes.effects').confirmDisputeEffect(tx,f.scope,id,raw))
const movement=(kind,principal,expectedVersion)=>({kind,principal,fee:'0',effectiveOn:'2026-11-24',reference:kind+'-'+randomUUID().slice(0,8),expectedVersion,requestKey:randomUUID()})
const credit=(db,f)=>require('../../src/modules/receivables').availableCredit(db,f.customer.id,{branch_id:f.branch.id})
async function act(db,f,id,kind,payload,{reviewer=f.reviewer}={}){
 const doc=await require('../../src/modules/cash-closure/disputes.queries').getDispute(db,f.scope,id),raw={kind,payload,expectedVersion:doc.version}
 const preview=await flow.previewDisputeAction(db,f.scope,id,raw)
 const proposal=await run(db,tx=>flow.proposeDisputeAction(tx,f.scope,id,{...raw,previewKey:preview.previewKey,requestKey:randomUUID()}))
 const decision={decision:'APPROVE',expectedVersion:doc.version,requestKey:randomUUID()}
 return {preview,proposal,decision,decide:(scope=reviewer)=>run(db,tx=>flow.decideDisputeProposal(tx,scope,id,proposal.id,decision))}
}
// Recibo Q100 con Q60 aplicados a una venta y Q40 libres; el banco retiró Q100 y el proveedor falló en contra.
async function lostCase(db,{applied='60',active=false,withdraw=true}={}){
 const f=await fixture(db)
 await db.companyModule.create({data:{company_id:f.company.id,module_code:'accounting',status:active?'ACTIVE':'DISABLED'}})
 const account=(code,name,type)=>db.account.create({data:{company_id:f.company.id,code,name,type}})
 const accounts={dispute:await account('1190','Fondos en disputa','ASSET'),receivables:await account('1130','Clientes por contracargo','ASSET'),advances:await account('2190','Anticipos de clientes','LIABILITY'),loss:await account('6190','Pérdida por contracargos','EXPENSE')}
 await db.$executeRaw`INSERT INTO cash_dispute_settings(company_id,dispute_account_id,fee_account_id,loss_account_id,receivables_account_id,advances_account_id,updated_by_id,reason)
   VALUES(${f.company.id}::uuid,${accounts.dispute.id},${f.accounts.fee.id},${accounts.loss.id},${accounts.receivables.id},${accounts.advances.id},${f.user.id}::uuid,'Configuración QA')`
 if(active)await run(db,tx=>require('../../src/services/accounting/core').createEntry(tx,{company_id:f.company.id,branch_id:f.branch.id,date:'2026-11-23',source_type:'CUSTOMER_ADVANCE',source_id:f.paymentId,description:'Cobro original',lines:[{account_id:f.accounts.clearing.id,debit:'100.00'},{account_id:accounts.advances.id,credit:'100.00'}]}))
 if(D(applied)>0){
  const status=await db.saleStatus.upsert({where:{name:'Completada'},create:{name:'Completada'},update:{}})
  const method=await db.paymentMethod.create({data:{company_id:f.company.id,name:'Crédito QA',is_credit:true}})
  const sale=await db.sale.create({data:{branch_id:f.branch.id,customer_contact_id:f.customer.id,status_id:status.id,payment_method_id:method.id,total:applied,adjusted_total:applied,items:0,created_by:f.user.id}})
  await db.salePaymentEntry.create({data:{sale_id:sale.id,customer_payment_id:f.paymentId,amount:applied}})
 }
 let doc=await run(db,tx=>flow.createDispute(tx,f.scope,{eventId:f.event.id,claimed:'100',providerReference:randomUUID(),reason:'Contracargo del banco',requestKey:randomUUID()}))
 if(withdraw)doc=await effect(db,f,doc.id,movement('BANK_DEBIT','100.00',doc.version))
 doc=await (await act(db,f,doc.id,'RESULT',{won:'0',lost:'100',reason:'El proveedor confirmó el contracargo'})).decide()
 return {f,doc,accounts}
}
function D(v){return Number(v)}
module.exports={run,effect,movement,credit,act,lostCase}
