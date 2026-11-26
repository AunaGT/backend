const { canonicalHash, fail } = require('./disputes.domain')
const { lockCustomer } = require('../receivables/domain/receivables')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const validId = value => typeof value === 'string' && uuid.test(value)

function assertCommandScope(scope) {
  if (![scope?.companyId,scope?.branchId,scope?.userId].every(validId)) {
    fail('DISPUTE_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal para esta operación', 403)
  }
  return {companyId:scope.companyId.toLowerCase(),branchId:scope.branchId.toLowerCase(),userId:scope.userId.toLowerCase()}
}
async function beginDisputeCommand(tx, scope, action, command, payload) {
  scope=assertCommandScope(scope)
  if (!validId(command?.requestKey) || typeof action !== 'string' || !/^[A-Z_]{1,40}$/.test(action)) {
    fail('DISPUTE_ATTEMPT_INVALID', 'Actualiza la pantalla antes de confirmar esta operación')
  }
  const key = command.requestKey.toLowerCase(), hash = canonicalHash(payload)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-dispute-command',scope.companyId,scope.branchId,scope.userId,action,key])},0))::text`
  const [old] = await tx.$queryRaw`SELECT content_hash,result FROM cash_dispute_commands
    WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid
      AND actor_id=${scope.userId}::uuid AND action=${action} AND request_key=${key}::uuid`
  if (old) {
    if (old.content_hash !== hash) fail('DISPUTE_ATTEMPT_CONFLICT', 'Este intento corresponde a otra operación. Recupera su resultado antes de continuar.', 409)
    return { replayed:true, result:old.result }
  }
  return {replayed:false,companyId:scope.companyId,branchId:scope.branchId,userId:scope.userId,action,key,hash}
}
async function finishDisputeCommand(tx, attempt, result) {
  if (attempt.replayed) return attempt.result
  await tx.$executeRaw`INSERT INTO cash_dispute_commands(company_id,branch_id,actor_id,action,request_key,content_hash,result)
    VALUES(${attempt.companyId}::uuid,${attempt.branchId}::uuid,${attempt.userId}::uuid,${attempt.action},${attempt.key}::uuid,${attempt.hash},${JSON.stringify(result)}::jsonb)`
  return result
}
async function lockDisputeResources(tx, scope, resources) {
  const context=scope
  scope=assertCommandScope(scope)
  const sorted = raw => {
    if (!Array.isArray(raw) || raw.some(id => !validId(id))) fail('DISPUTE_ORIGIN_INVALID', 'El origen de la operación no es válido')
    return [...new Set(raw.map(id=>id.toLowerCase()))].sort()
  }
  const customerIds=sorted(resources.customerIds),eventIds=sorted(resources.eventIds)
  for (const id of customerIds) await lockCustomer(tx,id)
  for (const id of eventIds) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-dispute-origin',scope.companyId,id])},0))::text`
  }
  if(resources.selection) {
    const current=await discoverDisputeResources(tx,context,resources.selection)
    if(current.baseKey!==resources.baseKey)fail('DISPUTE_ORIGIN_CHANGED','El origen cambió. Revisa sus datos antes de continuar.',409)
  }
  return {customerIds,eventIds}
}
async function discoverDisputeResources(db,rawScope,input={}) {
  const scope=assertCommandScope(rawScope)
  const ids=raw=>{
    if(!Array.isArray(raw)||raw.some(id=>!validId(id)))fail('DISPUTE_ORIGIN_INVALID','El origen no es válido')
    return [...new Set(raw.map(id=>id.toLowerCase()))].sort()
  }
  const selection={eventIds:ids(input.eventIds||[]),settlementIds:ids(input.settlementIds||[])}
  const events=new Set(selection.eventIds),settlements=[]
  for(const id of selection.settlementIds) {
    const [s]=await db.$queryRaw`SELECT id,status,journal_entry_id FROM cash_settlements WHERE id=${id}::uuid AND company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid`
    if(!s)fail('DISPUTE_NOT_FOUND','Origen no encontrado',404)
    settlements.push(s)
    const origins=await db.$queryRaw`SELECT event_id FROM cash_settlement_allocations WHERE settlement_id=${s.id}::uuid
      UNION SELECT event_id FROM cash_settlement_deductions WHERE settlement_id=${s.id}::uuid AND event_id IS NOT NULL`
    origins.forEach(e=>events.add(e.event_id))
  }
  const eventIds=[...events].sort()
  const rows=eventIds.length?await db.$queryRaw`SELECT e.id,e.company_id,e.branch_id,e.source_type,e.source_id,e.content_hash,
    coalesce(p.customer_id,s.customer_contact_id) AS customer_id FROM cash_money_events e
    LEFT JOIN customer_payments p ON e.source_type='CUSTOMER_PAYMENT' AND p.id=e.source_id
    LEFT JOIN sales s ON e.source_type='SALE' AND s.id=e.source_id
    WHERE e.id=ANY(${eventIds}::uuid[]) AND e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid ORDER BY e.id`:[]
  if(rows.length!==eventIds.length)fail('DISPUTE_NOT_FOUND','Origen no encontrado en esta sucursal',404)
  const customerIds=[...new Set(rows.map(r=>r.customer_id).filter(Boolean))].sort()
  return {selection,eventIds,customerIds,documentIds:selection.settlementIds,
    baseKey:canonicalHash({origins:rows,settlements})}
}
module.exports = {validId,assertCommandScope,beginDisputeCommand,finishDisputeCommand,lockDisputeResources,discoverDisputeResources}
