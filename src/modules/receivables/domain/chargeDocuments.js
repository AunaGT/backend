// Cargos por contracargo y créditos de recuperación como documentos de cartera.
// Un cargo no es una venta: no tiene ítems, impuestos, stock ni documento fiscal.
const {Prisma}=require('@prisma/client')
const round2=n=>Math.round((Number(n)+Number.EPSILON)*100)/100
const EPS=0.005
// Un cargo vence al terminar su día de vencimiento, no a medianoche del inicio.
// ponytail: fecha civil → mediodía UTC para que cartera, que formatea en la zona de la empresa, no la corra un día; vale para zonas entre −11 y +11.
const civilNoon=d=>d==null?null:new Date(d).toISOString().slice(0,10)+'T12:00:00.000Z'
const civilDay=d=>d instanceof Date?d.toISOString().slice(0,10):String(d).slice(0,10)
const chargeOverdue=(dueOn,now=new Date())=>new Date(civilDay(dueOn)+'T00:00:00Z').getTime()+86400000<=now.getTime()

// Dobles de prueba sin SQL crudo no tienen tablas de disputas: equivalen a un esquema sin cargos.
const ready=db=>typeof db?.$queryRaw==='function'&&require('../../cash-closure/disputes.queries').disputesAvailable(db)
// Acepta los filtros de sucursal que ya usa cartera: {}, {branch_id:'…'} o {branch_id:{in:[…]}}.
function branchSql(alias,where={}){
 const b=where.branch_id
 if(typeof b==='string')return Prisma.sql`AND ${Prisma.raw(alias)}.branch_id=${b}::uuid`
 if(Array.isArray(b?.in))return b.in.length?Prisma.sql`AND ${Prisma.raw(alias)}.branch_id=ANY(${b.in}::uuid[])`:Prisma.sql`AND false`
 return Prisma.empty
}
const chargePaid=Prisma.sql`coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_dispute_charge_applications WHERE charge_id=c.id),0)
 +coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_recovery_credit_applications WHERE charge_id=c.id),0)`
// Lo recuperado del banco o compensado reduce el cargo; lo recuperado de una parte ya pagada se vuelve crédito y no lo reduce otra vez.
const chargeReduced=Prisma.sql`coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=c.lot_id AND (x.kind='COMPENSATED'
 OR x.kind='RECOVERED' AND NOT EXISTS(SELECT 1 FROM customer_recovery_credits k WHERE k.lot_id=x.id))),0)`

/** Cargos con saldo pendiente, del que vence antes al último. */
async function openChargesOf(db,customerId,branchWhere={},{lock=false}={}){
 if(!await ready(db))return []
 const rows=await db.$queryRaw`SELECT c.id,c.reference,c.branch_id,c.issued_on,c.due_on,c.amount,c.dispute_id,${chargePaid} AS paid,${chargeReduced} AS reduced
   FROM customer_dispute_charges c WHERE c.customer_id=${customerId}::uuid ${branchSql('c',branchWhere)} ORDER BY c.due_on,c.issued_on,c.id ${lock?Prisma.sql`FOR UPDATE OF c`:Prisma.empty}`
 return rows.map(r=>({documentType:'DISPUTE_CHARGE',id:r.id,reference:r.reference,branch_id:r.branch_id,date:civilNoon(r.issued_on),due_date:civilNoon(r.due_on),disputeId:r.dispute_id,
   amount:round2(r.amount),paid:round2(r.paid),reduced:round2(r.reduced),balance:round2(Number(r.amount)-Number(r.paid)-Number(r.reduced))})).filter(r=>r.balance>EPS)
}
/** Créditos de recuperación todavía no aplicados: no son dinero recibido, solo saldo a favor sobre cargos. */
async function recoveryCreditsOf(db,customerId,branchWhere={}){
 if(!await ready(db))return []
 const rows=await db.$queryRaw`SELECT k.id,k.branch_id,k.amount,k.created_at,
   k.amount-coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_recovery_credit_applications WHERE credit_id=k.id),0) AS available
   FROM customer_recovery_credits k WHERE k.customer_id=${customerId}::uuid ${branchSql('k',branchWhere)} ORDER BY k.created_at,k.id`
 return rows.map(r=>({sourceType:'RECOVERY_CREDIT',id:r.id,branch_id:r.branch_id,createdAt:r.created_at,available:round2(r.available)})).filter(r=>r.available>EPS)
}
// Al cobrar un cargo baja lo que el cliente debe de ese cobro: la reserva de su recibo original se recalcula.
async function refreshChargeOrigins(tx,scope,chargeIds){
 if(!chargeIds.length)return
 const rows=await tx.$queryRaw`SELECT DISTINCT d.event_id FROM customer_dispute_charges c JOIN cash_payment_disputes d ON d.id=c.dispute_id WHERE c.id=ANY(${chargeIds}::uuid[]) ORDER BY d.event_id`
 const receipts=require('../../cash-closure/disputes.receipts')
 for(const r of rows)await receipts.refreshOriginReceiptRestrictions(tx,scope,r.event_id)
}
async function applyReceiptToCharges(tx,scope,{paymentId,customerId,applications}){
 for(const a of applications)await tx.$executeRaw`INSERT INTO customer_dispute_charge_applications(charge_id,payment_id,company_id,branch_id,customer_id,amount,actor_id)
   VALUES(${a.documentId}::uuid,${paymentId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${customerId}::uuid,${a.amount}::numeric,${scope.userId}::uuid)`
 await refreshChargeOrigins(tx,scope,[...new Set(applications.map(a=>a.documentId))])
}
async function applyRecoveryCreditToCharge(tx,scope,{creditId,chargeId,customerId,amount}){
 await tx.$executeRaw`INSERT INTO customer_recovery_credit_applications(credit_id,charge_id,company_id,branch_id,customer_id,amount,actor_id)
   VALUES(${creditId}::uuid,${chargeId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${customerId}::uuid,${amount}::numeric,${scope.userId}::uuid)`
}
/** Agregados por cliente para listas y antigüedad, con el mismo cálculo que el detalle. */
async function chargeTotalsByCustomer(db,branchIds,now=new Date()){
 if(!await ready(db)||!branchIds.length)return new Map()
 const rows=await db.$queryRaw`SELECT c.customer_id,c.due_on,c.amount-${chargePaid}-${chargeReduced} AS balance
   FROM customer_dispute_charges c WHERE c.branch_id=ANY(${branchIds}::uuid[])`
 const byCustomer=new Map()
 for(const r of rows){
  const balance=round2(r.balance);if(balance<=EPS)continue
  const t=byCustomer.get(r.customer_id)||{saldo:0,vencido:0,cargos:0,vencidos:0,items:[]}
  const overdue=chargeOverdue(r.due_on,now)
  t.saldo=round2(t.saldo+balance);t.cargos++;if(overdue){t.vencido=round2(t.vencido+balance);t.vencidos++}
  t.items.push({due_date:r.due_on,balance});byCustomer.set(r.customer_id,t)
 }
 return byCustomer
}
async function recoveryCreditTotalsByCustomer(db,branchIds){
 if(!await ready(db)||!branchIds.length)return new Map()
 const rows=await db.$queryRaw`SELECT k.customer_id,sum(k.amount-coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_recovery_credit_applications WHERE credit_id=k.id),0)) AS available
   FROM customer_recovery_credits k WHERE k.branch_id=ANY(${branchIds}::uuid[]) GROUP BY k.customer_id`
 return new Map(rows.map(r=>[r.customer_id,round2(r.available)]))
}
/** Estado de cuenta: todos los cargos del cliente (también los cubiertos) y sus créditos de recuperación. */
async function chargeStatementOf(db,customerId,branchWhere={},now=new Date()){
 if(!await ready(db))return {cargos:[],creditos_recuperacion:[]}
 const charges=await db.$queryRaw`SELECT c.id,c.reference,c.issued_on,c.due_on,c.amount,c.reason,c.dispute_id,d.provider_reference,${chargePaid} AS paid,${chargeReduced} AS reduced
   FROM customer_dispute_charges c JOIN cash_payment_disputes d ON d.id=c.dispute_id WHERE c.customer_id=${customerId}::uuid ${branchSql('c',branchWhere)} ORDER BY c.issued_on DESC,c.id DESC`
 const credits=await recoveryCreditsOf(db,customerId,branchWhere)
 return {cargos:charges.map(c=>{const saldo=Math.max(0,round2(Number(c.amount)-Number(c.paid)-Number(c.reduced)));const vencido=saldo>EPS&&chargeOverdue(c.due_on,now)
   return {id:c.id,tipo:'CARGO_CONTRACARGO',reference:c.reference,date:civilNoon(c.issued_on),due_date:civilNoon(c.due_on),total:round2(c.amount),abonado:round2(c.paid),recuperado:round2(c.reduced),saldo,
     vencido,dias_vencido:vencido?Math.floor((now-new Date(c.due_on))/86400000):0,dispute_id:c.dispute_id,referencia_proveedor:c.provider_reference,motivo:c.reason}}),
  creditos_recuperacion:credits.map(c=>({id:c.id,origen:'Recuperación de contracargo',disponible:c.available,created_at:c.createdAt}))}
}
/** Aplicaciones de recibos a cargos, para mostrarlas junto a las ventas que cubre cada cobro. */
async function chargeApplicationsOfReceipts(db,paymentIds){
 if(!paymentIds.length||!await ready(db))return new Map()
 const rows=await db.$queryRaw`SELECT a.payment_id,c.id AS charge_id,c.reference,c.issued_on,c.due_on,c.amount AS total,sum(CASE a.action WHEN 'APPLY' THEN a.amount ELSE -a.amount END) AS amount
   FROM customer_dispute_charge_applications a JOIN customer_dispute_charges c ON c.id=a.charge_id WHERE a.payment_id=ANY(${paymentIds}::uuid[]) GROUP BY a.payment_id,c.id,c.reference,c.issued_on,c.due_on,c.amount`
 const byPayment=new Map()
 for(const r of rows){if(round2(r.amount)<=EPS)continue;const list=byPayment.get(r.payment_id)||[];list.push({documentType:'DISPUTE_CHARGE',charge_id:r.charge_id,reference:r.reference,date:civilNoon(r.issued_on),due_date:civilNoon(r.due_on),total:round2(r.total),amount:round2(r.amount)});byPayment.set(r.payment_id,list)}
 return byPayment
}
// Un recibo con reclamo, saldo cancelado o cargo cobrado conserva su historia: no se elimina.
async function receiptDisputeDependency(db,paymentId){
 if(!await ready(db))return false
 const [row]=await db.$queryRaw`SELECT EXISTS(SELECT 1 FROM customer_dispute_charge_applications WHERE payment_id=${paymentId}::uuid)
   OR EXISTS(SELECT 1 FROM customer_receipt_restrictions WHERE payment_id=${paymentId}::uuid)
   OR EXISTS(SELECT 1 FROM cash_dispute_lots WHERE payment_id=${paymentId}::uuid)
   OR EXISTS(SELECT 1 FROM cash_payment_disputes d JOIN cash_dispute_receipt_origins(${paymentId}::uuid) o ON o.origin_id=d.event_id) AS found`
 return row.found===true
}
/**
 * Cargos abiertos con los filtros del listado de facturas, en la misma forma de fila.
 * Devuelve el total y los primeros `take` por vencimiento para mezclarlos con las ventas.
 */
async function chargeInvoices(db,companyId,{branchIds,state='ALL',customerId=null,term='',from=null,to=null,now=new Date(),take}){
 if(!await ready(db)||!branchIds.length)return {total:0,items:[]}
 const rows=await db.$queryRaw`SELECT c.id,c.reference,c.issued_on,c.due_on,c.amount,c.customer_id,s.name AS customer_name,${chargePaid} AS paid,${chargeReduced} AS reduced
   FROM customer_dispute_charges c JOIN suppliers s ON s.id=c.customer_id
   WHERE c.company_id=${companyId}::uuid AND c.branch_id=ANY(${branchIds}::uuid[]) AND (${customerId}::uuid IS NULL OR c.customer_id=${customerId}::uuid)
     AND (${term}='' OR position(lower(${term}) IN lower(c.reference||' '||s.name))>0)
     AND (${from}::timestamptz IS NULL OR c.issued_on>=(${from}::timestamptz)::date) AND (${to}::timestamptz IS NULL OR c.issued_on<(${to}::timestamptz)::date)
   ORDER BY c.due_on,c.issued_on,c.id`
 const items=rows.map(r=>{const total=round2(Number(r.amount)-Number(r.reduced)),saldo=round2(total-Number(r.paid)),vencida=chargeOverdue(r.due_on,now)
   return {id:r.id,documentType:'DISPUTE_CHARGE',reference:r.reference,date:civilNoon(r.issued_on),due_date:civilNoon(r.due_on),total,abonado:round2(r.paid),saldo,
     payment_status:Number(r.paid)>EPS?'PARTIAL':'PENDING',customer_id:r.customer_id,customer_name:r.customer_name,vencida,dias_vencida:vencida?Math.floor((now-new Date(r.due_on))/86400000):0}})
  .filter(r=>r.saldo>EPS)
  .filter(r=>state==='OVERDUE'?r.vencida:state==='UPCOMING'?!r.vencida&&new Date(r.due_date)<=new Date(now.getTime()+30*86400000):state==='PARTIAL'?r.payment_status==='PARTIAL':true)
 return {total:items.length,items:items.slice(0,take)}
}
module.exports={chargeOverdue,openChargesOf,recoveryCreditsOf,refreshChargeOrigins,applyReceiptToCharges,applyRecoveryCreditToCharge,chargeTotalsByCustomer,recoveryCreditTotalsByCustomer,chargeStatementOf,chargeApplicationsOfReceipts,receiptDisputeDependency,chargeInvoices}
