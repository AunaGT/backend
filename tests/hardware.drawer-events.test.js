const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {harness,ids}=require('./helpers/hardwareHarness.cjs')
const events=()=>require('../src/modules/config/hardware/drawer/events')
async function fixture(){
 const h=harness();h.scope.permissions=['sales.create','hardware.test_drawer'];h.clock=new Date('2026-10-17T18:00:00Z')
 h.db.$queryRaw=async(strings,...values)=>{
  const sql=strings.join('?')
  if(sql.includes('SET state=\'CLAIMED\'')){
   const row=h.rows('hardwareDrawerIntent').find(r=>r.id===values[0]&&r.state==='PENDING'&&new Date(r.expires_at)>h.clock)
   if(!row)return[];row.state='CLAIMED';row.claimed_at=h.clock;return[{claimed_at:h.clock,expires_at:row.expires_at}]
  }
  if(sql.includes('UPDATE hardware_drawer_intents i')){
   const [outcome,id,attemptId]=values,row=h.rows('hardwareDrawerIntent').find(r=>r.id===id&&r.state==='CLAIMED'),attempt=h.rows('hardwareDrawerAttempt').find(a=>a.id===attemptId&&a.intent_id===id)
   if(!row||!attempt||new Date(row.expires_at)<=h.clock||new Date(attempt.expires_at)<=h.clock)return[]
   row.state=outcome;return[{id}]
  }
  return[{now:h.clock}]
 }
 h.session=await h.db.cashRegisterSession.create({data:{cash_register_id:ids.register,status:'OPEN',opened_by_id:ids.actor,cashRegister:{branch_id:ids.branch,active:true}}})
 h.station=await h.db.hardwareWorkstation.create({data:{company_id:ids.company,branch_id:ids.branch,cash_register_id:ids.register,state:'ACTIVE'}})
 h.printer=await h.db.hardwareDevice.create({data:{company_id:ids.company,branch_id:ids.branch,name:'Ticket',kind:'RECEIPT_PRINTER',state:'ACTIVE',profile:{}}})
 h.drawer=await h.db.hardwareDevice.create({data:{company_id:ids.company,branch_id:ids.branch,name:'Gaveta',kind:'CASH_DRAWER',state:'ACTIVE',profile:{parentPrinterId:h.printer.id}}})
 for(const[role,id]of [['RECEIPT',h.printer.id],['DRAWER',h.drawer.id]])await h.db.hardwareAssignment.create({data:{company_id:ids.company,branch_id:ids.branch,workstation_id:h.station.id,role,device_id:id}})
 h.sale=await h.db.sale.create({data:{branch_id:ids.branch,branch:{company_id:ids.company},created_by:ids.actor,total:'10',sales_channel:'POS',settlement_source:'LEGACY',cash_register_session_id:h.session.id,payment_method:{is_credit:false,settlement_kind:'CASH'}}})
 return h
}
test('cash source creates one expiring simulated intent; canonical receipt never becomes a second sale intent',async()=>{
 const h=await fixture(),input={origin:'POS_SALE',sourceId:h.sale.id}
 const a=await events().enqueueDrawerIntent(h.db,h.scope,input),b=await events().enqueueDrawerIntent(h.db,h.scope,input)
 assert.ok(a.intentId);assert.equal(b.intentId,a.intentId);assert.equal(h.rows('hardwareDrawerIntent').length,1)
 const row=h.rows('hardwareDrawerIntent')[0];assert.equal(row.amount,'10');assert.equal(row.expires_at.toISOString(),'2026-10-17T18:00:30.000Z')
 await h.db.sale.updateMany({where:{id:h.sale.id},data:{payment_method:{is_credit:true,settlement_kind:'CASH'}}})
 assert.equal((await events().enqueueDrawerIntent(h.db,h.scope,input)).intentId,null)
})
test('no route, inactive policy, wrong actor, noncash and old classification skip without financial mutation',async()=>{
 for(const patch of [{payment_method:{settlement_kind:null}},{payment_method:{settlement_kind:'CARD'}},{total:'0'},{created_by:randomUUID()},{settlement_source:'ENGAGEMENT_RECEIPTS'}]){
  const h=await fixture();await h.db.sale.updateMany({where:{id:h.sale.id},data:patch});assert.equal((await events().enqueueDrawerIntent(h.db,h.scope,{origin:'POS_SALE',sourceId:h.sale.id})).intentId,null);assert.equal(h.rows('sale').length,1)
 }
 const h=await fixture();await h.db.hardwareWorkstation.updateMany({where:{id:h.station.id},data:{state:'DISABLED'}});assert.equal((await events().enqueueDrawerIntent(h.db,h.scope,{origin:'POS_SALE',sourceId:h.sale.id})).intentId,null)
})
module.exports={fixture}
test('initial/receivable/Agenda cash share one canonical receipt; returns use only actual refunds',async()=>{
 const h=await fixture();h.scope.permissions.push('receivables.manage','appointments.collect','returns.manage')
 await h.db.hardwareDrawerPolicy.create({data:{company_id:ids.company,version:1,policy:{posCashSale:true,initialCreditReceipt:true,receivableReceipt:true,agendaReceipt:true,cashReturn:true}}})
 const receipt=await h.db.customerPayment.create({data:{branch_id:ids.branch,branch:{company_id:ids.company},amount:'5',kind:'PAYMENT',registered_by:ids.actor,cash_register_session_id:h.session.id,payment_method:{settlement_kind:'CASH'}}})
 const idsOf=[]
 for(const origin of ['INITIAL_CREDIT_RECEIPT','RECEIVABLE_RECEIPT','AGENDA_RECEIPT'])idsOf.push((await events().enqueueDrawerIntent(h.db,h.scope,{origin,sourceId:receipt.id})).intentId)
 assert.ok(idsOf[0]);assert.equal(new Set(idsOf).size,1)
 const refund=await h.db.returnSettlement.create({data:{return:{sale:{branch_id:ids.branch,branch:{company_id:ids.company}}},kind:'REFUND',amount:'2',registered_by:ids.actor,cash_register_session_id:h.session.id,payment_method:{settlement_kind:'CASH'}}})
 assert.ok((await events().enqueueDrawerIntent(h.db,h.scope,{origin:'CASH_RETURN',sourceId:refund.id})).intentId)
 await h.db.returnSettlement.updateMany({where:{id:refund.id},data:{kind:'CREDIT_OFFSET'}})
 assert.equal((await events().enqueueDrawerIntent(h.db,h.scope,{origin:'CASH_RETURN',sourceId:refund.id})).intentId,null)
 assert.equal(h.rows('hardwareDrawerIntent').length,2)
})
