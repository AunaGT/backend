const {randomUUID}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {money,fail}=require('./disputes.domain')
const {authorize,fields,text,day,evidence,lockCase}=require('./disputes')
const boundary=require('./disputes.boundary')
const {getDispute,requireAvailable,originContext}=require('./disputes.queries')
const {freezeEffectAccounts}=require('./disputes.effects')
const {refreshOriginReceiptRestrictions}=require('./disputes.receipts')

async function deductionContext(db,scope,doc,deductionId){
 const [row]=await db.$queryRaw`SELECT x.*,s.company_id,s.branch_id,s.currency_code,s.status,s.journal_entry_id,b.payment_method_id,b.deposited_on
   FROM cash_settlement_deductions x JOIN cash_settlements s ON s.id=x.settlement_id JOIN cash_bank_deposits b ON b.id=s.deposit_id
   WHERE x.id::text=${String(deductionId)} AND s.company_id=${scope.companyId}::uuid AND s.branch_id=${scope.branchId}::uuid AND x.event_id=${doc.eventId}::uuid`
 if(!row)fail('DISPUTE_NOT_FOUND','Deducción no encontrada para este expediente',404)
 if(row.kind!=='CHARGEBACK'||row.status!=='POSTED'||row.currency_code!==doc.currencyCode||row.payment_method_id!==doc.methodId)fail('DISPUTE_DEDUCTION_INVALID','La deducción no corresponde a un contracargo vigente del mismo cobro, medio y moneda',409)
 return row
}
async function linkLegacyDeduction(tx,scope,caseId,raw){
 authorize(scope,'movements');await requireAvailable(tx)
 fields(raw,['deductionId','principal','reference','evidence','accountingDate','dateChangeReason','expectedVersion','requestKey'])
 if(!boundary.validId(raw.deductionId))fail('DISPUTE_INPUT_INVALID','Selecciona la deducción original completa')
 const principal=money(raw.principal),reference=text(raw.reference,'Referencia de la deducción',255)
 const payload={caseId,deductionId:raw.deductionId.toLowerCase(),principal:principal.toFixed(2),reference,evidence:evidence(raw.evidence,reference),
   expectedVersion:raw.expectedVersion,accountingDate:raw.accountingDate?day(raw.accountingDate,'Fecha contable'):null,dateChangeReason:raw.dateChangeReason?text(raw.dateChangeReason,'Motivo de la fecha contable',1000):null}
 const initial=await getDispute(tx,scope,caseId)
 await deductionContext(tx,scope,initial,payload.deductionId)
 const attempt=await boundary.beginDisputeCommand(tx,scope,'LINK_LEGACY_DEDUCTION',raw,payload)
 if(attempt.replayed)return attempt.result
 const source=await deductionContext(tx,scope,initial,payload.deductionId)
 await boundary.lockDisputeResources(tx,scope,await boundary.discoverDisputeResources(tx,scope,{eventIds:[initial.eventId],settlementIds:[source.settlement_id]}))
 const doc=await lockCase(tx,scope,caseId)
 await tx.$queryRaw`SELECT id FROM cash_settlements WHERE id=${source.settlement_id}::uuid FOR UPDATE`
 const deduction=await deductionContext(tx,scope,doc,payload.deductionId)
 if(!Number.isSafeInteger(payload.expectedVersion)||doc.version!==payload.expectedVersion)fail('DISPUTE_VERSION_CONFLICT','El expediente cambió. Revisa sus movimientos antes de vincular la deducción.',409)
 if(doc.status==='CANCELLED')fail('DISPUTE_STATE_CONFLICT','El expediente está cancelado',409)
 if(principal.lte(0)||!principal.eq(deduction.amount))fail('DISPUTE_DEDUCTION_AMOUNT','Debe vincularse el importe completo y exacto de la deducción original',409)
 const [linked]=await tx.$queryRaw`SELECT id FROM cash_dispute_events WHERE deduction_id=${deduction.id}::uuid`
 if(linked)fail('DISPUTE_DEDUCTION_LINKED','Esta deducción ya está vinculada a un expediente',409)
 if(principal.add(doc.withdrawn).gt(doc.claimed))fail('DISPUTE_EFFECT_EXCEEDS','La deducción supera el principal todavía atribuible a este expediente',409)
 const origin=await originContext(tx,scope,doc.eventId)
 if(origin.issues.length)fail('DISPUTE_ORIGIN_BLOCKED',origin.issues[0],409)
 const accounting={...await freezeEffectAccounts(tx,scope,doc,'BANK_DEBIT'),fundingAccountId:deduction.account_id},id=randomUUID()
 const economicOn=new Date(deduction.deposited_on).toISOString().slice(0,10)
 if(payload.accountingDate&&payload.accountingDate!==economicOn&&!payload.dateChangeReason)fail('DISPUTE_INPUT_INVALID','Explica por qué la fecha contable difiere de la liquidación original')
 await tx.$executeRaw`INSERT INTO cash_dispute_events(id,dispute_id,company_id,branch_id,kind,principal,economic_on,reference,evidence,payload,settlement_id,deduction_id,actor_id)
   VALUES(${id}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,'LEGACY_WITHHOLDING',${payload.principal}::numeric,${economicOn}::date,${reference},${JSON.stringify(payload.evidence)}::jsonb,
     ${JSON.stringify({accounting,requestedAccountingDate:payload.accountingDate,requestedDateReason:payload.dateChangeReason})}::jsonb,${deduction.settlement_id}::uuid,${deduction.id}::uuid,${scope.userId}::uuid)`
 await refreshOriginReceiptRestrictions(tx,scope,doc.eventId)
 await tx.$executeRaw`UPDATE cash_payment_disputes SET version=version+1 WHERE id=${doc.id}::uuid`
 await require('../../services/accounting/cashDisputePosting').postDisputeEffect(tx,scope,id,{accountingDate:payload.accountingDate??economicOn,dateChangeReason:payload.dateChangeReason})
 return boundary.finishDisputeCommand(tx,attempt,await getDispute(tx,scope,doc.id))
}
// Contracargos y recuperaciones dentro de una liquidación nueva: un efecto por expediente, enlazado a esa liquidación.
function settlementDisputeScope(scope){
 if(!scope.canDisputeMovements&&!scope.isAdmin)fail('DISPUTE_FORBIDDEN','Registrar contracargos o recuperaciones en una liquidación requiere el permiso de movimientos de disputas',403)
 const branch=scope.branchId.toLowerCase()
 return {companyId:scope.companyId.toLowerCase(),branchId:branch,branchIds:[branch],userId:scope.userId.toLowerCase(),isAdmin:!!scope.isAdmin,can:{read:true,movements:true}}
}
// Sin locks: solo identifica los cobros de cada expediente para tomarlos en el orden común.
async function settlementDisputeOrigins(tx,scope,caseIds){
 if(!caseIds.length)return []
 if(new Set(caseIds).size!==caseIds.length)fail('DISPUTE_INPUT_INVALID','Cada expediente puede aparecer una sola vez en la liquidación')
 const ds=settlementDisputeScope(scope),events=[]
 for(const caseId of [...caseIds].sort())events.push((await getDispute(tx,ds,caseId)).eventId)
 return events
}
// Con los orígenes ya bloqueados: bloquea expedientes, relee y valida cada movimiento contra su presupuesto.
async function lockSettlementDisputes(tx,scope,{methodId,chargebacks,recoveries}){
 const ids=[...chargebacks.map(c=>c.disputeId),...recoveries.map(r=>r.disputeId)].sort(),docs=new Map()
 if(!ids.length)return docs
 const ds=settlementDisputeScope(scope)
 await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`
 for(const caseId of ids){
  const doc=await getDispute(tx,ds,caseId)
  if(doc.status==='CANCELLED')fail('DISPUTE_STATE_CONFLICT','Un expediente de la liquidación está cancelado',409)
  if(doc.methodId!==methodId)fail('DISPUTE_INPUT_INVALID','El expediente no corresponde al medio de esta liquidación',409)
  docs.set(caseId,doc)
 }
 for(const c of chargebacks){
  const doc=docs.get(c.disputeId)
  if(doc.eventId!==c.eventId)fail('DISPUTE_INPUT_INVALID','El contracargo no corresponde al cobro de su expediente',409)
  const origin=await originContext(tx,ds,doc.eventId)
  if(origin.issues.length)fail('DISPUTE_ORIGIN_BLOCKED',origin.issues[0],409)
  const [legacy]=await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_settlement_deductions x JOIN cash_settlements s ON s.id=x.settlement_id
    WHERE x.event_id=${doc.eventId}::uuid AND x.kind='CHARGEBACK' AND s.status='POSTED' AND NOT EXISTS(SELECT 1 FROM cash_dispute_events e WHERE e.deduction_id=x.id)) AS found`
  if(legacy.found)fail('DISPUTE_LEGACY_REVIEW_REQUIRED','Existe una retención anterior en una liquidación. Vincúlala al expediente antes de registrar otra.',409)
  if(money(c.amount).add(doc.withdrawn).gt(doc.claimed))fail('DISPUTE_EFFECT_EXCEEDS','El contracargo supera el principal todavía atribuible a su expediente',409)
  c.accounting=await freezeEffectAccounts(tx,ds,doc,'PROVIDER_WITHHOLDING')
 }
 for(const r of recoveries){
  const doc=docs.get(r.disputeId)
  if(money(r.amount).gt(new Prisma.Decimal(doc.withdrawn).sub(doc.recovered)))fail('DISPUTE_EFFECT_EXCEEDS','La recuperación supera el principal retirado y todavía no recuperado',409)
  // Con resolución previa, lo recuperado vuelve primero al cliente y después revierte la pérdida asumida.
  r.plan=require('./disputes.domain').planBankRecovery({withdrawn:doc.withdrawn,recovered:doc.recovered,lots:await require('./disputes.resolutions').recoveryLots(tx,doc.id),principal:money(r.amount).toFixed(2)})
  r.accounting=await freezeEffectAccounts(tx,ds,doc,'BANK_RECOVERY')
 }
 return docs
}
async function recordSettlementDisputes(tx,scope,{settlementId,depositedOn,reference,bankAccountId,docs,chargebacks,recoveries}){
 if(!docs.size)return
 const ds=settlementDisputeScope(scope),insert=(c,kind,funding,deductionId,id=randomUUID())=>tx.$executeRaw`INSERT INTO cash_dispute_events(id,dispute_id,company_id,branch_id,kind,principal,economic_on,reference,evidence,payload,settlement_id,deduction_id,actor_id)
   VALUES(${id}::uuid,${c.disputeId}::uuid,${ds.companyId}::uuid,${ds.branchId}::uuid,${kind},${money(c.amount).toFixed(2)}::numeric,${depositedOn}::date,${reference},${JSON.stringify({identifier:reference})}::jsonb,
     ${JSON.stringify({accounting:{...c.accounting,fundingAccountId:funding}})}::jsonb,${settlementId}::uuid,${deductionId}::uuid,${ds.userId}::uuid)`
 for(const c of chargebacks)await insert(c,'PROVIDER_WITHHOLDING',c.accountId,c.id)
 const resolutions=require('./disputes.resolutions')
 for(const r of recoveries){
  r.eventId=randomUUID();await insert(r,'PROVIDER_RECOVERY',bankAccountId,null,r.eventId)
  if(r.plan.lots.length)await resolutions.applyRecoveryToLots(tx,ds,docs.get(r.disputeId),r.eventId,r.plan.lots,await resolutions.recoveryLots(tx,r.disputeId))
 }
 for(const eventId of new Set([...docs.values()].map(d=>d.eventId)))await refreshOriginReceiptRestrictions(tx,ds,eventId)
 await tx.$executeRaw`UPDATE cash_payment_disputes SET version=version+1 WHERE id=ANY(${[...docs.keys()]}::uuid[])`
}
module.exports={linkLegacyDeduction,settlementDisputeOrigins,lockSettlementDisputes,recordSettlementDisputes}
