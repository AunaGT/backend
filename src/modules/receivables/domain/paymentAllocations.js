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
  const available=received.minus(applied).minus(committed).minus(refunded)
  if (available.lt(0)) throw Object.assign(new Error('El recibo tiene destinos incompatibles'),{status:409,code:'PAYMENT_ALLOCATION_CONFLICT'})
  return Object.fromEntries(Object.entries({received,applied,committed,refunded,available}).map(([key,value])=>[key,value.toFixed(2)]))
}
function allocationForReceipt(payment){
  const sum=rows=>(rows||[]).reduce((total,row)=>total.add(String(row.amount)),new Prisma.Decimal(0)).toFixed(2)
  return receiptAllocation({received:String(payment.amount),applied:sum(payment.applications),
    committed:sum((payment.commitments||[]).filter(row=>row.state==='COMMITTED')),
    refunded:sum([...(payment.refunds||[]).filter(row=>row.status==='CONFIRMED'),...(payment.allocation_events||[]).filter(row=>row.action==='SALE_REFUNDED')])})
}
const allocationSelect={applications:{select:{amount:true}},commitments:{where:{state:'COMMITTED'},select:{amount:true,state:true}},refunds:{where:{status:'CONFIRMED'},select:{amount:true,status:true}},allocation_events:{where:{action:'SALE_REFUNDED'},select:{amount:true,action:true}}}
module.exports={money,receiptAllocation,allocationForReceipt,allocationSelect}
