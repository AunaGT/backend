const BASICS = [
  {name:'Efectivo',code:'CASH',kind:'CASH',credit:false},
  {name:'Tarjeta',code:'CARD',kind:'BANK',credit:false},
  {name:'Transferencia',code:'TRANSFER',kind:'BANK',credit:false},
  {name:'Crédito',code:'CREDIT',kind:'CREDIT',credit:true},
]
function setupError() {
  return Object.assign(new Error('Revisa la configuración de los métodos básicos: nombres o clasificación contradictorios'),{status:409,code:'PM_SETUP_REQUIRED'})
}
function inspectPaymentMethodBasics(rows) {
  const byCode=new Map(),seen=new Set()
  for(const row of rows) {
    if(row.company_id != null) continue
    const name=row.name.trim().toLowerCase()
    if(seen.has(name)) throw setupError()
    seen.add(name)
    const basic=BASICS.find(b=>b.name.toLowerCase()===name)
    if(!basic) { if(row.base_code != null) throw setupError(); continue }
    if(row.name!==row.name.trim() || row.is_credit!==basic.credit ||
      (row.base_code!=null&&row.base_code!==basic.code) ||
      (row.settlement_kind!=null&&row.settlement_kind!==basic.kind)) throw setupError()
    byCode.set(basic.code,row)
  }
  return {byCode,missing:BASICS.filter(b=>!byCode.has(b.code)).map(b=>b.code)}
}
async function ensurePaymentMethodBasics(tx) {
  const key='payment-methods:basics'
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`
  const {byCode}=inspectPaymentMethodBasics(await tx.paymentMethod.findMany({where:{company_id:null}}))
  for(const b of BASICS) {
    const row=byCode.get(b.code)
    if(!row) await tx.paymentMethod.create({data:{name:b.name,is_credit:b.credit,base_code:b.code,settlement_kind:b.kind}})
    else if(row.base_code==null||row.settlement_kind==null)
      await tx.paymentMethod.update({where:{id:row.id},data:{base_code:b.code,settlement_kind:b.kind}})
  }
}
module.exports={inspectPaymentMethodBasics,ensurePaymentMethodBasics}
