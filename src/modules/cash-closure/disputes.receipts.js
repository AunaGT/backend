const {Prisma}=require('@prisma/client')
const {fail}=require('./disputes.domain')
const {assertCommandScope,validId,discoverDisputeResources,lockDisputeResources}=require('./disputes.boundary')
const D=v=>new Prisma.Decimal(String(v??0))

async function refreshReceiptRestrictions(tx,scope,receiptIds) {
  const identity=assertCommandScope(scope)
  if(!Array.isArray(receiptIds)||receiptIds.some(id=>!validId(id)))fail('DISPUTE_RECEIPT_INVALID','El recibo no es válido')
  const ids=[...new Set(receiptIds.map(id=>id.toLowerCase()))].sort()
  if(!ids.length)return []
  const incoming=await tx.$queryRaw`SELECT p.id FROM customer_payments p JOIN branches b ON b.id=p.branch_id
    WHERE p.id=ANY(${ids}::uuid[]) AND p.branch_id=${identity.branchId}::uuid AND b.company_id=${identity.companyId}::uuid`
  if(incoming.length!==ids.length)fail('DISPUTE_NOT_FOUND','Recibo no encontrado',404)
  const origins=await tx.$queryRaw`SELECT DISTINCT o.origin_id FROM unnest(${ids}::uuid[]) p(id)
    CROSS JOIN LATERAL cash_dispute_receipt_origins(p.id) o ORDER BY o.origin_id`
  const deltas=[]
  for(const {origin_id:originId} of origins) {
    // Recompute all aliases together: two returned notes must never each reserve the full claim.
    const receipts=await tx.$queryRaw`SELECT p.id,p.customer_id,p.amount,
      coalesce((SELECT sum(amount) FROM sale_payment_entries WHERE customer_payment_id=p.id),0) AS applied,
      coalesce((SELECT sum(amount) FROM payment_commitments WHERE payment_id=p.id AND state='COMMITTED'),0) AS committed,
      cash_dispute_receipt_refunded(p.id) AS refunded,
      coalesce((SELECT sum(CASE action WHEN 'APPLY' THEN amount ELSE -amount END) FROM customer_dispute_charge_applications WHERE payment_id=p.id),0) AS charged
      FROM customer_payments p JOIN branches b ON b.id=p.branch_id
      WHERE p.branch_id=${identity.branchId}::uuid AND b.company_id=${identity.companyId}::uuid
      AND EXISTS(SELECT 1 FROM cash_dispute_receipt_origins(p.id) o WHERE o.origin_id=${originId}::uuid)
      ORDER BY p.paid_at,p.id`
    const cases=await tx.$queryRaw`SELECT d.id,d.claimed,d.status,d.won,d.lost,cash_dispute_charge_open(d.id) AS charge_open,
      coalesce((SELECT sum(cash_dispute_effect_delta(e.kind,r.kind,e.principal)) FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=d.id),0) AS exposure,
      coalesce((SELECT sum(CASE WHEN e.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN e.principal WHEN e.kind='COMPENSATION' AND r.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN -e.principal ELSE 0 END) FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=d.id),0) AS recovered,
      coalesce((SELECT sum(CASE WHEN l.kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN l.principal ELSE -l.principal END) FROM cash_dispute_lots l WHERE l.dispute_id=d.id),0) AS disposed
      FROM cash_payment_disputes d WHERE d.event_id=${originId}::uuid AND d.company_id=${identity.companyId}::uuid AND d.branch_id=${identity.branchId}::uuid ORDER BY d.created_at,d.id`
    if(!cases.length)continue
    const previous=await tx.$queryRaw`SELECT r.* FROM customer_receipt_restrictions r JOIN cash_payment_disputes d ON d.id=r.dispute_id WHERE d.event_id=${originId}::uuid`
    const retiredRows=await tx.$queryRaw`SELECT l.payment_id,l.dispute_id,
      sum(l.principal-coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=l.id AND x.kind IN('RECOVERED','COMPENSATED')),0)) AS amount
      FROM cash_dispute_lots l JOIN cash_payment_disputes d ON d.id=l.dispute_id WHERE d.event_id=${originId}::uuid AND l.kind='RECEIPT_RETIRED' GROUP BY l.payment_id,l.dispute_id`
    const key=(paymentId,caseId)=>paymentId+':'+caseId
    const oldById=new Map(previous.map(r=>[key(r.payment_id,r.dispute_id),r]))
    const retiredById=new Map(retiredRows.map(r=>[key(r.payment_id,r.dispute_id),D(r.amount)]))
    const free=new Map(receipts.map(p=>[p.id,D(p.amount).sub(p.applied).sub(p.committed).sub(p.refunded).sub(p.charged)
      .sub(retiredRows.filter(r=>r.payment_id===p.id).reduce((sum,r)=>sum.add(r.amount),D(0)))]))
    if([...free.values(),...retiredById.values()].some(amount=>amount.lt(0)))fail('DISPUTE_RECEIPT_CONFLICT','El recibo tiene destinos incompatibles. Revisa su historial.',409)
    for(const c of cases) {
      const lostPending=Prisma.Decimal.max(0,D(c.lost).sub(Prisma.Decimal.max(0,D(c.recovered).sub(c.won))))
      // Un saldo que vuelve al recibo no se usa mientras el cliente siga debiendo el cargo de ese mismo cobro.
      let need=Prisma.Decimal.max(0,(['OPEN','SUBMITTED'].includes(c.status)?D(c.claimed):Prisma.Decimal.max(lostPending,D(c.exposure))).sub(c.disposed)).add(c.charge_open)
      for(const p of receipts) {
        const held=Prisma.Decimal.min(free.get(p.id),need),retired=retiredById.get(key(p.id,c.id))||D(0)
        free.set(p.id,free.get(p.id).sub(held));need=need.sub(held)
        const old=oldById.get(key(p.id,c.id))
        if(old&&D(old.held).eq(held)&&D(old.retired).eq(retired))continue
        await tx.$executeRaw`INSERT INTO customer_receipt_restrictions(payment_id,dispute_id,company_id,branch_id,customer_id,held,retired)
          VALUES(${p.id}::uuid,${c.id}::uuid,${identity.companyId}::uuid,${identity.branchId}::uuid,${p.customer_id}::uuid,${held.toFixed(2)}::numeric,${retired.toFixed(2)}::numeric)
          ON CONFLICT(payment_id,dispute_id) DO UPDATE SET held=excluded.held,retired=excluded.retired,version=customer_receipt_restrictions.version+1,updated_at=clock_timestamp()`
        const delta={paymentId:p.id,caseId:c.id,held:held.toFixed(2),retired:retired.toFixed(2)}
        await tx.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,payload,accounting_status,actor_id)
          VALUES(${c.id}::uuid,${identity.companyId}::uuid,${identity.branchId}::uuid,'COMMUNICATION',${JSON.stringify({action:'RECEIPT_ALLOCATION',...delta})}::jsonb,'ZERO',${identity.userId}::uuid)`
        await tx.$executeRaw`UPDATE cash_payment_disputes SET version=version+1 WHERE id=${c.id}::uuid`
        deltas.push(delta)
      }
    }
  }
  return deltas
}
async function refreshOriginReceiptRestrictions(tx,scope,eventId) {
  const rows=await tx.$queryRaw`SELECT p.id FROM customer_payments p WHERE p.branch_id=${scope.branchId}::uuid
    AND EXISTS(SELECT 1 FROM cash_dispute_receipt_origins(p.id) o WHERE o.origin_id=${eventId}::uuid)`
  return refreshReceiptRestrictions(tx,scope,rows.map(p=>p.id))
}
async function prepareDisputedReceiptMutation(tx,scope,receiptIds) {
  if(!await require('./disputes.queries').disputesAvailable(tx))return null
  const identity=assertCommandScope(scope)
  if(!Array.isArray(receiptIds)||receiptIds.some(id=>!validId(id)))fail('DISPUTE_RECEIPT_INVALID','El recibo no es válido')
  const events=await tx.$queryRaw`SELECT e.id FROM cash_money_events e WHERE e.id IN(SELECT o.origin_id FROM unnest(${receiptIds}::uuid[]) p(id) CROSS JOIN LATERAL cash_dispute_receipt_origins(p.id) o)
    AND e.company_id=${identity.companyId}::uuid AND e.branch_id=${identity.branchId}::uuid`
  if(!events.length)return null
  const resources=await discoverDisputeResources(tx,scope,{eventIds:events.map(e=>e.id)})
  await lockDisputeResources(tx,scope,resources)
  return resources
}
module.exports={refreshReceiptRestrictions,refreshOriginReceiptRestrictions,prepareDisputedReceiptMutation}
