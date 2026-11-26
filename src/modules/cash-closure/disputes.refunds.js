const {Prisma}=require('@prisma/client')
const {money,fail}=require('./disputes.domain')
const {assertCommandScope,validId,discoverDisputeResources,lockDisputeResources}=require('./disputes.boundary')
const {disputesAvailable}=require('./disputes.queries')
const {prepareDisputedReceiptMutation,refreshReceiptRestrictions}=require('./disputes.receipts')

async function prepareSaleRefundMutation(tx,rawScope,saleId) {
  if(!await disputesAvailable(tx))return null
  const scope=assertCommandScope(rawScope)
  const rows=await tx.$queryRaw`SELECT e.id FROM cash_money_events e WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid
    AND e.direction='IN' AND e.settlement_kind='BANK' AND ((e.source_type='SALE' AND e.source_id=${saleId}::uuid)
    OR e.id IN(SELECT o.origin_id FROM sale_payment_entries a CROSS JOIN LATERAL cash_dispute_receipt_origins(a.customer_payment_id) o WHERE a.sale_id=${saleId}::uuid))`
  const resources=await discoverDisputeResources(tx,scope,{eventIds:rows.map(e=>e.id)})
  await lockDisputeResources(tx,scope,resources)
  return resources
}

// Attribution shares the caller's refund transaction; it never creates a second payout.
async function recordReturnAllocations(tx,rawScope,settlementId,allocations) {
  return recordRefundAllocations(tx,rawScope,'RETURN_SETTLEMENT',settlementId,allocations)
}
async function recordConfirmedReceiptRefund(tx,scope,refund) {
  return recordRefundAllocations(tx,scope,'CUSTOMER_PAYMENT_REFUND',refund.id,[{paymentId:refund.payment_id,amount:String(refund.amount)}])
}
async function recordReturnedSaleCredit(tx,rawScope,settlementId,paymentId) {
  if(!await disputesAvailable(tx))return
  const scope=assertCommandScope(rawScope)
  if(!validId(settlementId)||!validId(paymentId))fail('DISPUTE_REFUND_INVALID','El saldo devuelto no tiene una atribución válida')
  const [row]=await tx.$queryRaw`SELECT rs.id,rs.amount,s.customer_contact_id AS customer_id,e.id AS event_id
    FROM return_settlements rs JOIN returns r ON r.id=rs.return_id JOIN sales s ON s.id=r.sale_id JOIN branches b ON b.id=s.branch_id
    JOIN cash_money_events e ON e.source_type='SALE' AND e.source_id=s.id AND e.direction='IN' AND e.settlement_kind='BANK'
    WHERE rs.id=${settlementId}::uuid AND rs.kind='CUSTOMER_CREDIT' AND b.company_id=${scope.companyId}::uuid AND s.branch_id=${scope.branchId}::uuid`
  if(!row)return
  await lockDisputeResources(tx,scope,await discoverDisputeResources(tx,scope,{eventIds:[row.event_id]}))
  await tx.$executeRaw`INSERT INTO cash_refund_allocations(company_id,branch_id,customer_id,payment_id,origin_event_id,source_type,source_id,action,amount,actor_id)
    VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${row.customer_id}::uuid,${paymentId}::uuid,${row.event_id}::uuid,'RETURN_SETTLEMENT',${row.id}::uuid,'TRANSFER',${String(row.amount)}::numeric,${scope.userId}::uuid)`
  await refreshReceiptRestrictions(tx,scope,[paymentId])
}
async function recordRefundAllocations(tx,rawScope,sourceType,settlementId,allocations) {
  if(!await disputesAvailable(tx))return
  const scope=assertCommandScope(rawScope)
  if(!validId(settlementId)||!Array.isArray(allocations)||allocations.some(a=>!validId(a.paymentId)||money(a.amount).lte(0)))fail('DISPUTE_REFUND_INVALID','La devolución no tiene una atribución válida')
  const [source]=sourceType==='RETURN_SETTLEMENT'?await tx.$queryRaw`SELECT rs.id,rs.kind,s.customer_contact_id AS customer_id FROM return_settlements rs
    JOIN returns r ON r.id=rs.return_id JOIN sales s ON s.id=r.sale_id JOIN branches b ON b.id=s.branch_id
    WHERE rs.id=${settlementId}::uuid AND s.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid`:
    await tx.$queryRaw`SELECT id,'REFUND' AS kind,customer_id FROM customer_payment_refunds WHERE id=${settlementId}::uuid
      AND company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND status='CONFIRMED'`
  if(!source)fail('DISPUTE_NOT_FOUND','Devolución no encontrada',404)
  if(!['REFUND','CUSTOMER_CREDIT'].includes(source.kind))fail('DISPUTE_REFUND_INVALID','Esta liquidación no devuelve dinero ni libera saldo')
  const receiptIds=[...new Set(allocations.map(a=>a.paymentId.toLowerCase()))].sort()
  if(source.customer_id)await require('../receivables/domain/receivables').lockCustomer(tx,source.customer_id)
  await prepareDisputedReceiptMutation(tx,scope,receiptIds)
  for(const allocation of allocations) {
    const [payment]=await tx.$queryRaw`SELECT p.id,e.id AS event_id FROM customer_payments p JOIN branches b ON b.id=p.branch_id
      LEFT JOIN cash_money_events e ON e.id IN(SELECT origin_id FROM cash_dispute_receipt_origins(p.id))
      WHERE p.id=${allocation.paymentId}::uuid AND p.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND p.customer_id=${source.customer_id}::uuid`
    if(!payment)fail('DISPUTE_NOT_FOUND','Recibo no encontrado',404)
    let funded=money('0'),funding=[]
    if(source.kind==='REFUND'&&payment.event_id) {
      const [budget]=await tx.$queryRaw`SELECT e.amount-cash_dispute_origin_refunded(e.id)+cash_dispute_funded_refunds(e.id)-cash_dispute_origin_used(e.id) AS claimable,
        coalesce((SELECT sum(a.amount) FROM payment_allocation_events a WHERE a.payment_id=${payment.id}::uuid AND a.return_settlement_id=${source.id}::uuid AND a.action='SALE_REFUNDED'),0) AS recorded
        FROM cash_money_events e WHERE e.id=${payment.event_id}::uuid`
      const additional=sourceType==='CUSTOMER_PAYMENT_REFUND'?money('0'):Prisma.Decimal.max(0,money(allocation.amount).sub(budget.recorded))
      let needed=Prisma.Decimal.max(0,additional.sub(budget.claimable))
      if(needed.gt(allocation.amount))fail('DISPUTE_REFUND_RESTRICTED','El cobro necesita revisión antes de registrar otra devolución.',409)
      const lots=needed.gt(0)?await tx.$queryRaw`SELECT l.id,greatest(0,l.principal
        -coalesce((SELECT sum(c.principal) FROM cash_dispute_lots c WHERE c.target_lot_id=l.id AND c.kind IN('RECOVERED','COMPENSATED')),0)
        -coalesce((SELECT sum(a.amount) FROM cash_refund_allocations a WHERE a.funding_lot_id=l.id),0)) AS available
        FROM cash_dispute_lots l JOIN cash_payment_disputes d ON d.id=l.dispute_id
        WHERE d.event_id=${payment.event_id}::uuid AND l.kind='ABSORBED' ORDER BY l.created_at,l.id`:[]
      for(const lot of lots) {
        const amount=Prisma.Decimal.min(needed,new Prisma.Decimal(lot.available))
        if(amount.lte(0))continue
        funding.push({lotId:lot.id,amount:amount.toFixed(2)});funded=funded.add(amount);needed=needed.sub(amount)
      }
      if(needed.gt(0))fail('DISPUTE_REFUND_RESTRICTED','El importe está en disputa. Antes de devolverlo, una persona autorizada debe resolver la pérdida y conservar este saldo a favor.',409)
    }
    const unfunded=money(allocation.amount).sub(funded)
    if(unfunded.gt(0))funding.push({lotId:null,amount:unfunded.toFixed(2)})
    for(const part of funding)await tx.$executeRaw`INSERT INTO cash_refund_allocations(company_id,branch_id,customer_id,payment_id,origin_event_id,source_type,source_id,action,amount,funding_lot_id,actor_id)
      VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${source.customer_id}::uuid,${payment.id}::uuid,${payment.event_id}::uuid,${sourceType},${source.id}::uuid,${source.kind==='REFUND'?'REFUND':'RELEASE'},${part.amount}::numeric,${part.lotId}::uuid,${scope.userId}::uuid)`
  }
  await refreshReceiptRestrictions(tx,scope,receiptIds)
}
// Devolución de una venta directa con tarjeta/banco: no puede usar principal que un reclamo todavía ocupa.
// Solo orígenes con expediente; sin disputa la devolución sigue igual que antes.
// ponytail: el reembolso se atribuye a la venta, no al medio; una venta mixta con disputa puede rechazarse de más (falla cerrada, 409).
async function assertSaleRefundCoverage(tx,rawScope,saleId) {
  if(!await disputesAvailable(tx))return
  const scope=assertCommandScope(rawScope)
  const blocked=await tx.$queryRaw`SELECT e.id FROM cash_money_events e WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid
    AND e.direction='IN' AND e.settlement_kind='BANK' AND e.source_type='SALE' AND e.source_id=${saleId}::uuid
    AND EXISTS(SELECT 1 FROM cash_payment_disputes d WHERE d.event_id=e.id)
    AND cash_dispute_origin_used(e.id)+cash_dispute_origin_refunded(e.id)-cash_dispute_funded_refunds(e.id)>e.amount`
  if(blocked.length)fail('DISPUTE_REFUND_RESTRICTED','Este cobro tiene una disputa que todavía ocupa su principal. Resuelve el expediente antes de devolver el dinero.',409)
}
module.exports={assertSaleRefundCoverage,prepareSaleRefundMutation,recordReturnAllocations,recordConfirmedReceiptRefund,recordReturnedSaleCredit}
