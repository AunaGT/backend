const { Prisma } = require('@prisma/client')

function money(raw) {
  const value = raw instanceof Prisma.Decimal ? raw.toString() : raw
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) invalidMoney()
  const decimal = new Prisma.Decimal(value)
  if (!decimal.isFinite() || decimal.lt(0) || decimal.gte('10000000000')) invalidMoney()
  return decimal
}
function invalidMoney() {
  throw Object.assign(new Error('Indica un importe válido con hasta dos decimales'), {status:400,code:'INVALID_MONEY'})
}
function receiptAllocation(input) {
  const received=money(input.received),applied=money(input.applied),committed=money(input.committed),refunded=money(input.refunded)
  const held=money(input.held??'0'),retired=money(input.retired??'0'),chargeApplied=money(input.chargeApplied??'0')
  const available=received.minus(applied).minus(committed).minus(refunded).minus(held).minus(retired).minus(chargeApplied)
  if (available.lt(0)) throw Object.assign(new Error('El recibo tiene destinos incompatibles'),{status:409,code:'PAYMENT_ALLOCATION_CONFLICT'})
  const result={received,applied,committed,refunded,available}
  if(['held','retired','chargeApplied'].some(key=>Object.hasOwn(input,key)))Object.assign(result,{held,retired,chargeApplied})
  return Object.fromEntries(Object.entries(result).map(([key,value])=>[key,value.toFixed(2)]))
}
function allocationForReceipt(payment){
  const sum=rows=>(rows||[]).reduce((total,row)=>total.add(String(row.amount)),new Prisma.Decimal(0)).toFixed(2)
  return receiptAllocation({received:String(payment.amount),applied:sum(payment.applications),
    committed:sum((payment.commitments||[]).filter(row=>row.state==='COMMITTED')),
    refunded:payment.dispute_allocation?.refunded??sum([...(payment.refunds||[]).filter(row=>row.status==='CONFIRMED'),...(payment.allocation_events||[]).filter(row=>row.action==='SALE_REFUNDED')]),
    ...(payment.dispute_allocation?{held:payment.dispute_allocation.held,retired:payment.dispute_allocation.retired,chargeApplied:payment.dispute_allocation.chargeApplied}:{})})
}
const allocationSelect={applications:{select:{amount:true}},commitments:{where:{state:'COMMITTED'},select:{amount:true,state:true}},refunds:{where:{status:'CONFIRMED'},select:{amount:true,status:true}},allocation_events:{where:{action:'SALE_REFUNDED'},select:{amount:true,action:true}}}
async function hydrateReceiptAllocations(db,payments){
  if(!payments.length||!Prisma.dmmf.datamodel.models.some(m=>m.name==='CashPaymentDispute'))return payments
  // Keep the old Prisma selection usable until the additive schema and client are both deployed.
  if(!await require('../../cash-closure/disputes.queries').disputesAvailable(db))return payments
  const rows=await db.$queryRaw`SELECT p.id,
    EXISTS(SELECT 1 FROM customer_receipt_restrictions WHERE payment_id=p.id) AS has_dispute,
    cash_dispute_receipt_refunded(p.id) AS refunded,
    coalesce((SELECT sum(held) FROM customer_receipt_restrictions WHERE payment_id=p.id),0) AS held,
    coalesce((SELECT sum(retired) FROM customer_receipt_restrictions WHERE payment_id=p.id),0) AS retired,
    coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_dispute_charge_applications WHERE payment_id=p.id),0) AS charge_applied
    FROM customer_payments p WHERE p.id=ANY(${payments.map(p=>p.id)}::uuid[])`
  const byId=new Map(rows.map(r=>[r.id,r]))
  return payments.map(p=>{
    const row=byId.get(p.id)
    if(!row)throw Object.assign(new Error('El recibo cambió. Revisa sus destinos antes de continuar.'),{status:409,code:'PAYMENT_ALLOCATION_CONFLICT'})
    return {...p,has_dispute:row.has_dispute,dispute_allocation:{refunded:String(row.refunded),held:String(row.held),retired:String(row.retired),chargeApplied:String(row.charge_applied)}}
  })
}
module.exports={money,receiptAllocation,allocationForReceipt,allocationSelect,hydrateReceiptAllocations}
