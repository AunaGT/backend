// Datos del reporte de disputas: una fila por expediente abierto en el período, cada dimensión por separado.
const {Prisma}=require('@prisma/client')
const n=v=>Math.round(Number(v||0)*100)/100
const WITHDRAW=['BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING'],RECOVER=['BANK_RECOVERY','PROVIDER_RECOVERY']
async function disputeReportRows(db,{companyId,branchIds,start=null,endExclusive=null}){
 if(!branchIds.length||!await require('./disputes.queries').disputesAvailable(db))return null
 const rows=await db.$queryRaw`SELECT d.id,d.created_at,d.status,d.provider_reference,d.currency_code,d.claimed,b.name AS branch,s.name AS customer,pm.name AS method,
   coalesce((SELECT sum(CASE WHEN e.kind=ANY(${WITHDRAW}) THEN e.principal WHEN e.kind='COMPENSATION' AND r.kind=ANY(${WITHDRAW}) THEN -e.principal ELSE 0 END) FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=d.id),0) AS withdrawn,
   coalesce((SELECT sum(CASE WHEN e.kind=ANY(${RECOVER}) THEN e.principal WHEN e.kind='COMPENSATION' AND r.kind=ANY(${RECOVER}) THEN -e.principal ELSE 0 END) FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=d.id),0) AS recovered,
   coalesce((SELECT sum(CASE WHEN e.kind='COMPENSATION' THEN -e.fee WHEN e.kind=ANY(${[...WITHDRAW,...RECOVER]}) THEN e.fee ELSE 0 END) FROM cash_dispute_events e WHERE e.dispute_id=d.id),0) AS fees,
   coalesce((SELECT sum(l.principal-coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=l.id AND x.kind IN('RECOVERED','COMPENSATED')),0)) FROM cash_dispute_lots l WHERE l.dispute_id=d.id AND l.kind='ABSORBED'),0) AS loss,
   coalesce((SELECT sum(l.principal-coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=l.id AND x.kind='COMPENSATED'),0)) FROM cash_dispute_lots l WHERE l.dispute_id=d.id AND l.kind='CUSTOMER_CHARGE'),0) AS charged,
   coalesce((SELECT sum(amount) FROM customer_recovery_credits WHERE dispute_id=d.id),0) AS credited
   FROM cash_payment_disputes d JOIN branches b ON b.id=d.branch_id LEFT JOIN suppliers s ON s.id=d.customer_id JOIN payment_methods pm ON pm.id=d.payment_method_id
   WHERE d.company_id=${companyId}::uuid AND d.branch_id=ANY(${branchIds}::uuid[])
     ${start?Prisma.sql`AND d.created_at>=${new Date(start)}`:Prisma.empty} ${endExclusive?Prisma.sql`AND d.created_at<${new Date(endExclusive)}`:Prisma.empty}
   ORDER BY d.created_at,d.id LIMIT 10001`
 return rows.map(r=>({id:r.id,createdAt:new Date(r.created_at).toISOString(),status:r.status,providerReference:r.provider_reference,currency:r.currency_code,branch:r.branch,customer:r.customer||null,method:r.method,
  claimed:n(r.claimed),withdrawn:n(r.withdrawn),recovered:n(r.recovered),fees:n(r.fees),loss:n(r.loss),charged:n(r.charged),credited:n(r.credited)}))
}
module.exports={disputeReportRows}
