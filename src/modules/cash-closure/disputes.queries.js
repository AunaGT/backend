const {Prisma}=require('@prisma/client')
const {money,fail,canonicalHash,calculateOriginCoverage}=require('./disputes.domain')
const {validId}=require('./disputes.boundary')
const D=value=>new Prisma.Decimal(String(value??0))
const civil=value=>value?new Date(value).toISOString().slice(0,10):null
const statuses=['OPEN','SUBMITTED','WON','PARTIALLY_LOST','LOST','CANCELLED']
// El expediente muestra el efecto comercial; las cuentas y evidencias privadas tienen su propia autoridad.
const publicPayload=raw=>({...publicFields(raw),...(raw?.plan&&typeof raw.plan==='object'?{planRetired:String(raw.plan.retired),planCharged:String(raw.plan.charged),planAbsorbed:String(raw.plan.absorbed)}:{})})
const publicFields=raw=>Object.fromEntries(['action','kind','reason','status','proposalId','won','lost','customerPrincipal','absorbedPrincipal','dueOn','held','retired','selfReview','selfReviewReason','fileName','mimeType','fileSize','lotKind','amount','issuedOn']
  .filter(key=>['string','boolean'].includes(typeof raw?.[key])).map(key=>[key,raw[key]]))

function readScope(scope) {
  const branches=scope?.branchIds||(scope?.branchId?[scope.branchId]:[])
  if (!scope?.can?.read || !validId(scope.companyId) || !validId(scope.userId) || !branches.length || !branches.every(validId)) {
    fail('DISPUTE_FORBIDDEN','No tienes acceso a estos reclamos',403)
  }
  return {...scope,companyId:scope.companyId.toLowerCase(),branchIds:[...new Set(branches.map(id=>id.toLowerCase()))]}
}
async function disputesAvailable(db) {
  if(!Prisma.dmmf.datamodel.models.some(m=>m.name==='CashPaymentDispute'))return false
  const [row]=await db.$queryRaw`SELECT to_regclass('cash_payment_disputes') IS NOT NULL
    AND to_regclass('cash_dispute_commands') IS NOT NULL AND to_regclass('cash_dispute_events') IS NOT NULL
    AND to_regclass('customer_receipt_restrictions') IS NOT NULL AND to_regclass('customer_dispute_charges') IS NOT NULL
    AND to_regclass('customer_recovery_credit_applications') IS NOT NULL
    AND to_regclass('cash_refund_allocations') IS NOT NULL AS ok`
  return row?.ok===true
}
async function requireAvailable(db) {
  if(!await disputesAvailable(db))fail('DISPUTE_UNAVAILABLE','Las disputas todavía no están disponibles en esta instalación',409)
}
async function caseMoney(db,caseId) {
  const [row]=await db.$queryRaw`SELECT
    coalesce(sum(CASE WHEN e.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') THEN e.principal
      WHEN e.kind='COMPENSATION' AND r.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') THEN -e.principal ELSE 0 END),0) AS withdrawn,
    coalesce(sum(CASE WHEN e.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN e.principal
      WHEN e.kind='COMPENSATION' AND r.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN -e.principal ELSE 0 END),0) AS recovered,
    coalesce(sum(CASE WHEN e.kind='COMPENSATION' THEN -e.fee WHEN e.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY') THEN e.fee ELSE 0 END),0) AS fees
    FROM cash_dispute_events e LEFT JOIN cash_dispute_events r ON r.id=e.reversal_of_id WHERE e.dispute_id=${caseId}::uuid`
  return {withdrawn:D(row.withdrawn).toFixed(2),recovered:D(row.recovered).toFixed(2),fees:D(row.fees).toFixed(2)}
}
async function originContext(db,rawScope,eventId) {
  const scope=readScope(rawScope)
  if(!validId(eventId))fail('DISPUTE_NOT_FOUND','Cobro no encontrado',404)
  const [e]=await db.$queryRaw`SELECT e.id,e.company_id,e.branch_id,e.source_type,e.source_id,e.direction,e.settlement_kind,e.amount,
    e.currency_code,e.payment_method_id,e.payment_method_name,e.economic_at,e.recorded_at,e.reference,e.content_hash,
    cp.kind AS receipt_kind,coalesce(cp.customer_id,s.customer_contact_id) AS customer_id,c.name AS customer_name,
    coalesce(c.deleted,false) AS customer_deleted,c.estado AS customer_state,m.mode,m.account_id,
    (SELECT value FROM system_settings WHERE company_id=e.company_id AND key='currency_code') AS current_currency
    FROM cash_money_events e LEFT JOIN customer_payments cp ON e.source_type='CUSTOMER_PAYMENT' AND cp.id=e.source_id
    LEFT JOIN sales s ON e.source_type='SALE' AND s.id=e.source_id
    LEFT JOIN suppliers c ON c.id=coalesce(cp.customer_id,s.customer_contact_id)
    LEFT JOIN cash_bank_event_modes m ON m.event_id=e.id
    WHERE e.id=${eventId.toLowerCase()}::uuid AND e.company_id=${scope.companyId}::uuid AND e.branch_id=ANY(${scope.branchIds}::uuid[])`
  if(!e)fail('DISPUTE_NOT_FOUND','Cobro no encontrado',404)
  const available=await disputesAvailable(db),issues=[]
  if(e.direction!=='IN'||e.settlement_kind!=='BANK'||!['SALE','CUSTOMER_PAYMENT'].includes(e.source_type))issues.push('Este origen no es un cobro digital de venta o cartera.')
  if(e.source_type==='CUSTOMER_PAYMENT'&&e.receipt_kind!=='PAYMENT')issues.push('El documento de origen no es un recibo de dinero real.')
  if(!['DIRECT','DEFERRED'].includes(e.mode))issues.push('El cobro no conserva una configuración bancaria aprobada. Su historial sigue disponible.')
  if(!e.currency_code||e.current_currency!==e.currency_code)issues.push('La moneda original y la moneda actual de la empresa son diferentes. No se convierten automáticamente.')
  let refunded=D(0),fundedRefunds=D(0),legacy=false
  if(e.source_type==='CUSTOMER_PAYMENT') {
    const attributed=available?Prisma.sql`cash_dispute_receipt_refunded(${e.source_id}::uuid)`:Prisma.sql`
      coalesce((SELECT sum(amount) FROM customer_payment_refunds WHERE payment_id=${e.source_id}::uuid AND status='CONFIRMED'),0)
      +coalesce((SELECT sum(amount) FROM payment_allocation_events WHERE payment_id=${e.source_id}::uuid AND action='SALE_REFUNDED'),0)`
    const unattributed=available?Prisma.sql`AND NOT EXISTS(SELECT 1 FROM cash_refund_allocations a WHERE a.source_type='RETURN_SETTLEMENT' AND a.source_id=rs.id)`:Prisma.empty
    const [r]=await db.$queryRaw`SELECT ${attributed} AS refunded,
      EXISTS(SELECT 1 FROM return_settlements rs JOIN returns rt ON rt.id=rs.return_id JOIN sales s ON s.id=rt.sale_id JOIN payment_methods pm ON pm.id=s.payment_method_id
        WHERE s.customer_contact_id=${e.customer_id}::uuid AND s.branch_id=${e.branch_id}::uuid AND pm.is_credit
        AND rs.created_at>=${e.economic_at} AND rs.kind IN('REFUND','CUSTOMER_CREDIT')
        AND NOT EXISTS(SELECT 1 FROM payment_allocation_events a WHERE a.return_settlement_id=rs.id) ${unattributed}) AS legacy`
    refunded=D(r.refunded);legacy=r.legacy
  } else if(e.source_type==='SALE') {
    const unattributed=available?Prisma.sql`AND NOT EXISTS(SELECT 1 FROM cash_refund_allocations a WHERE a.source_type='RETURN_SETTLEMENT' AND a.source_id=rs.id AND a.action='TRANSFER' AND a.origin_event_id=${e.id}::uuid AND a.amount=rs.amount)`:Prisma.empty
    // Sin FROM: una venta sin devoluciones también devuelve una fila (antes no devolvía ninguna y fallaba).
    const returned=available?Prisma.sql`cash_dispute_origin_refunded(${e.id}::uuid)`:Prisma.sql`(SELECT coalesce(sum(rs.amount),0) FROM return_settlements rs JOIN returns r ON r.id=rs.return_id WHERE r.sale_id=${e.source_id}::uuid AND rs.kind='REFUND')`
    const [r]=await db.$queryRaw`SELECT ${returned} AS refunded,
      EXISTS(SELECT 1 FROM return_settlements rs JOIN returns r ON r.id=rs.return_id WHERE r.sale_id=${e.source_id}::uuid AND rs.kind='CUSTOMER_CREDIT' ${unattributed}) AS legacy`
    refunded=D(r.refunded);legacy=r.legacy
  }
  if(available){const [r]=await db.$queryRaw`SELECT cash_dispute_funded_refunds(${e.id}::uuid) AS amount`;fundedRefunds=D(r.amount)}
  if(legacy)issues.push('Existen devoluciones anteriores sin atribución verificable a este cobro. Este origen requiere revisión y permanece de solo consulta.')
  const cases=available?await db.$queryRaw`SELECT d.id,d.claimed,d.status,d.won,d.lost,
    coalesce((SELECT sum(CASE WHEN ev.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') THEN ev.principal WHEN ev.kind='COMPENSATION' AND r.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') THEN -ev.principal ELSE 0 END) FROM cash_dispute_events ev LEFT JOIN cash_dispute_events r ON r.id=ev.reversal_of_id WHERE ev.dispute_id=d.id),0) AS withdrawn,
    coalesce((SELECT sum(CASE WHEN ev.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN ev.principal WHEN ev.kind='COMPENSATION' AND r.kind IN('BANK_RECOVERY','PROVIDER_RECOVERY') THEN -ev.principal ELSE 0 END) FROM cash_dispute_events ev LEFT JOIN cash_dispute_events r ON r.id=ev.reversal_of_id WHERE ev.dispute_id=d.id),0) AS recovered
    FROM cash_payment_disputes d WHERE d.event_id=${e.id}::uuid ORDER BY d.id`:[]
  const coverage=calculateOriginCoverage({amount:D(e.amount).toFixed(2),refunded:refunded.toFixed(2),fundedRefunds:fundedRefunds.toFixed(2),cases:cases.map(c=>({claimed:D(c.claimed).toFixed(2),pending:['OPEN','SUBMITTED'].includes(c.status),withdrawn:D(c.withdrawn).toFixed(2),recovered:D(c.recovered).toFixed(2),won:D(c.won).toFixed(2),lost:D(c.lost).toFixed(2)}))})
  if(!available)issues.push('La instalación todavía no tiene habilitado el registro de disputas.')
  if(available){
    const [reversed]=await db.$queryRaw`SELECT EXISTS(SELECT 1 FROM journal_entries j JOIN journal_entries r ON r.reversal_of_id=j.id
      WHERE j.company_id=${scope.companyId}::uuid AND j.source_id=${e.source_id}::text AND j.source_type::text=ANY(${e.source_type==='SALE'?['SALE']:['SALE_PAYMENT','CUSTOMER_ADVANCE']}::text[])) AS found`
    if(reversed.found)issues.push('El asiento del cobro original fue anulado. Requiere revisión contable antes de abrir una disputa.')
  }
  const baseKey=canonicalHash({hash:e.content_hash,refunded:refunded.toFixed(2),fundedRefunds:fundedRefunds.toFixed(2),cases:cases.map(c=>({id:c.id,status:c.status,claimed:String(c.claimed),withdrawn:String(c.withdrawn),recovered:String(c.recovered)})),currency:e.current_currency,legacy})
  return {eventId:e.id,sourceType:e.source_type,sourceId:e.source_id,companyId:e.company_id,branchId:e.branch_id,
    customerId:e.customer_id,customerName:e.customer_name,canChargeCustomer:!!e.customer_id&&!e.customer_deleted&&e.customer_state===1,
    currencyCode:e.currency_code,methodId:e.payment_method_id,methodName:e.payment_method_name,mode:e.mode,
    amount:D(e.amount).toFixed(2),effectiveRefunded:refunded.toFixed(2),claimable:coverage.claimable,available,
    eligible:available&&!issues.length&&D(coverage.claimable).gt(0),issues,baseKey,economicAt:new Date(e.economic_at).toISOString(),reference:e.reference}
}
async function getDispute(db,rawScope,caseId) {
  const scope=readScope(rawScope)
  if(!validId(caseId))fail('DISPUTE_NOT_FOUND','Disputa no encontrada',404)
  await requireAvailable(db)
  const [d]=await db.$queryRaw`SELECT d.*,c.name AS customer_name,u.name AS created_by_name,m.mode AS origin_mode,
    CASE WHEN m.mode='DEFERRED' THEN e.amount-cash_dispute_provider_withheld(e.id)-coalesce((SELECT sum(abs(a.amount)) FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=e.id AND s.status='POSTED'),0) END AS provider_pending
    FROM cash_payment_disputes d JOIN cash_money_events e ON e.id=d.event_id LEFT JOIN cash_bank_event_modes m ON m.event_id=e.id
    LEFT JOIN suppliers c ON c.id=d.customer_id JOIN users u ON u.id=d.created_by_id
    WHERE d.id=${caseId.toLowerCase()}::uuid AND d.company_id=${scope.companyId}::uuid AND d.branch_id=ANY(${scope.branchIds}::uuid[])`
  if(!d)fail('DISPUTE_NOT_FOUND','Disputa no encontrada',404)
  const [policy]=scope.isAdmin&&scope.can.resolve?await db.$queryRaw`SELECT owner_self_review FROM cash_dispute_settings WHERE company_id=${scope.companyId}::uuid`:[]
  const totals=await caseMoney(db,d.id)
  const [replacement]=await db.$queryRaw`SELECT id FROM cash_payment_disputes WHERE replaces_dispute_id=${d.id}::uuid AND company_id=${scope.companyId}::uuid AND branch_id=ANY(${scope.branchIds}::uuid[])`
  const [lotTotals]=await db.$queryRaw`SELECT coalesce(sum(CASE WHEN kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') THEN principal ELSE -principal END),0) AS disposed,
    coalesce(sum(CASE WHEN kind='CUSTOMER_CHARGE' THEN principal ELSE 0 END),0) AS charged FROM cash_dispute_lots WHERE dispute_id=${d.id}::uuid`
  const [credits]=await db.$queryRaw`SELECT coalesce(sum(amount),0) AS amount FROM customer_recovery_credits WHERE dispute_id=${d.id}::uuid`
  const history=await db.$queryRaw`SELECT e.id,e.kind,e.principal::text,e.fee::text,e.reference,e.payload,e.economic_on,e.accounting_on,e.accounting_status,e.created_at,u.name AS actor_name
    FROM cash_dispute_events e JOIN users u ON u.id=e.actor_id WHERE e.dispute_id=${d.id}::uuid ORDER BY e.created_at,e.id`
  const proposals=await db.$queryRaw`SELECT p.*,u.name AS proposed_by_name,r.name AS decided_by_name FROM cash_dispute_proposals p
    JOIN users u ON u.id=p.proposed_by_id LEFT JOIN users r ON r.id=p.decided_by_id WHERE p.dispute_id=${d.id}::uuid ORDER BY p.proposed_at DESC,p.id`
  // Resoluciones vivas (para condonar o corregir) y deducciones históricas del mismo cobro aún sin expediente.
  const lots=await db.$queryRaw`SELECT l.id,l.kind,c.reference AS charge_reference,
    l.principal-coalesce((SELECT sum(x.principal) FROM cash_dispute_lots x WHERE x.target_lot_id=l.id AND x.kind IN('RECOVERED','COMPENSATED')),0) AS remaining
    FROM cash_dispute_lots l LEFT JOIN customer_dispute_charges c ON c.lot_id=l.id
    WHERE l.dispute_id=${d.id}::uuid AND l.kind IN('ABSORBED','RECEIPT_RETIRED','CUSTOMER_CHARGE') ORDER BY l.created_at,l.id`
  const {chargeOutstanding}=require('./disputes.resolutions')
  const liveLots=[]
  for(const l of lots){
    const outstanding=l.kind==='CUSTOMER_CHARGE'?(await chargeOutstanding(db,l.id)).outstanding.toFixed(2):null
    if(D(l.remaining).gt(0))liveLots.push({id:l.id,kind:l.kind,remaining:D(l.remaining).toFixed(2),outstanding,chargeReference:l.charge_reference??null})
  }
  const legacyDeductions=await db.$queryRaw`SELECT x.id,x.amount,x.settlement_id,b.deposited_on,b.reference FROM cash_settlement_deductions x
    JOIN cash_settlements s ON s.id=x.settlement_id JOIN cash_bank_deposits b ON b.id=s.deposit_id
    WHERE x.event_id=${d.event_id}::uuid AND x.kind='CHARGEBACK' AND s.status='POSTED' AND s.company_id=${scope.companyId}::uuid AND s.branch_id=${d.branch_id}::uuid
      AND NOT EXISTS(SELECT 1 FROM cash_dispute_events e WHERE e.deduction_id=x.id) ORDER BY b.deposited_on,x.id`
  const exposure=D(totals.withdrawn).sub(totals.recovered),unresolved=Prisma.Decimal.max(0,exposure.sub(lotTotals.disposed))
  return {id:d.id,eventId:d.event_id,companyId:d.company_id,branchId:d.branch_id,customerId:d.customer_id,customerName:d.customer_name,
    methodId:d.payment_method_id,currencyCode:d.currency_code,originMode:d.origin_mode,providerPending:d.provider_pending==null?null:D(d.provider_pending).toFixed(2),claimed:D(d.claimed).toFixed(2),won:D(d.won).toFixed(2),lost:D(d.lost).toFixed(2),
    status:d.status,version:d.version,providerReference:d.provider_reference,reason:d.reason,deadline:civil(d.deadline),
    replacesCaseId:d.replaces_dispute_id,replacedByCaseId:replacement?.id??null,ownerSelfReviewEnabled:!!policy?.owner_self_review,
    createdById:d.created_by_id,createdByName:d.created_by_name,createdAt:new Date(d.created_at).toISOString(),...totals,
    charged:D(lotTotals.charged).toFixed(2),customerCredit:D(credits.amount).toFixed(2),disposed:D(lotTotals.disposed).toFixed(2),unresolved:unresolved.toFixed(2),
    lots:liveLots,legacyDeductions:legacyDeductions.map(x=>({id:x.id,amount:D(x.amount).toFixed(2),settlementId:x.settlement_id,depositedOn:civil(x.deposited_on),reference:x.reference})),
    history:history.map(e=>({...e,payload:publicPayload(e.payload),economic_on:civil(e.economic_on),accounting_on:civil(e.accounting_on),created_at:new Date(e.created_at).toISOString()})),
    proposals:proposals.map(p=>({...p,payload:publicPayload(p.payload),proposed_at:new Date(p.proposed_at).toISOString(),decided_at:p.decided_at?new Date(p.decided_at).toISOString():null})),
    can:{...scope.can,manage:!!scope.branchId&&scope.can.manage,movements:!!scope.branchId&&scope.can.movements,resolve:!!scope.branchId&&scope.can.resolve,charge:!!scope.branchId&&scope.can.charge}}
}
async function listDisputes(db,rawScope,query={}) {
  const scope=readScope(rawScope);await requireAvailable(db)
  const page=Number.isSafeInteger(Number(query.page))&&Number(query.page)>0?Number(query.page):1
  const pageSize=Number.isSafeInteger(Number(query.pageSize))&&Number(query.pageSize)>0?Math.min(100,Number(query.pageSize)):20
  if(query.status&&!statuses.includes(query.status))fail('DISPUTE_FILTER_INVALID','El estado seleccionado no es válido')
  const status=query.status||null,q=String(query.q||'').trim().slice(0,120)
  if(query.methodId!=null&&!/^\d{1,9}$/.test(String(query.methodId)))fail('DISPUTE_FILTER_INVALID','El medio seleccionado no es válido')
  const methodId=query.methodId==null?null:Number(query.methodId)
  const filter=Prisma.sql`company_id=${scope.companyId}::uuid AND branch_id=ANY(${scope.branchIds}::uuid[]) AND (${status}::text IS NULL OR status=${status}) AND (${methodId}::int IS NULL OR payment_method_id=${methodId}) AND (${q}='' OR position(lower(${q}) IN lower(provider_reference||' '||reason))>0)`
  const [{total}]=await db.$queryRaw`SELECT count(*)::int AS total FROM cash_payment_disputes WHERE ${filter}`
  const rows=await db.$queryRaw`SELECT id,event_id,payment_method_id,status,version,currency_code,claimed::text,won::text,lost::text,provider_reference,deadline,created_at FROM cash_payment_disputes
    WHERE ${filter} ORDER BY created_at DESC,id LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`
  return {items:rows.map(r=>({...r,deadline:civil(r.deadline),created_at:new Date(r.created_at).toISOString()})),totalItems:total,page,pageSize,totalPages:Math.max(1,Math.ceil(total/pageSize))}
}
module.exports={readScope,disputesAvailable,requireAvailable,caseMoney,originContext,getDispute,listDisputes,civil}
