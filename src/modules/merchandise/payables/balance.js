const {toCents,fromCents,checked,fail}=require('./money')
function balanceOf(row){
  let total=0,paid=0,legacy=0,reason=null
  try{
    total=row.total_amount!==undefined?toCents(row.total_amount):(row.items||[]).reduce((n,i)=>{if(!Number.isInteger(i.quantity)||i.quantity<0)fail('Cantidad inválida');return checked(n+checked(i.quantity*toCents(i.unit_cost)))},0)
    paid=row.documented_paid!==undefined?toCents(row.documented_paid):(row.paymentEntries||[]).filter(p=>!p.cancelled_at).reduce((n,p)=>checked(n+toCents(p.amount)),0)
    legacy=toCents(row.legacy_settled_amount??'0')
    if(row.payment_balance_review_required)reason='El registro histórico necesita revisión'
    if(checked(paid+legacy)>total)reason='Los pagos superan el total de la entrada'
  }catch{reason='El importe del documento necesita revisión'}
  const balance=reason?null:fromCents(total-paid-legacy)
  return{total:fromCents(total),documentedPaid:fromCents(paid),legacySettled:fromCents(legacy),balance,status:reason?'REVIEW':total===paid+legacy?'PAID':paid+legacy>0?'PARTIAL':'PENDING',excluded:row.source==='INITIAL',reason,revision:row.payment_revision||0}
}
function planApplications(entries,input){
  const byId=new Map(entries.map(e=>[e.id,e])),seen=new Set(),applications=[];let sum=0
  if(!input.applications?.length||input.applications.length>100)fail('Selecciona de 1 a 100 entradas')
  for(const app of input.applications){
    const entry=byId.get(app.incomingId)
    if(!entry||entry.excluded)fail('Entrada no disponible',404,'ENTRY_UNAVAILABLE')
    if(seen.has(entry.id))fail('Una entrada no puede repetirse');seen.add(entry.id)
    if(entry.balance==null)fail('Revisa el saldo histórico antes de pagar',409,'BALANCE_REVIEW')
    if(entry.revision!==app.expectedRevision)fail('El saldo cambió. Actualiza la selección y revisa el pago',409,'STALE_BALANCE',{entries})
    const cents=toCents(app.amount)
    if(cents<=0||cents>toCents(entry.balance))fail('El abono debe ser positivo y no superar el saldo',409,'STALE_BALANCE',{entries})
    sum=checked(sum+cents);applications.push({incomingId:entry.id,amount:fromCents(cents)})
  }
  if(sum!==toCents(input.amount)||sum===0)fail('El monto debe coincidir exactamente con las aplicaciones')
  return applications
}
module.exports={balanceOf,planApplications}
