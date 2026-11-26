const {randomUUID}=require('node:crypto')
const {Prisma}=require('@prisma/client')
const {money,fail}=require('./disputes.domain')
const {authorize,fields,text,day,evidence,lockCase}=require('./disputes')
const {beginDisputeCommand,finishDisputeCommand}=require('./disputes.boundary')
const {requireAvailable,getDispute,originContext}=require('./disputes.queries')
const {refreshOriginReceiptRestrictions}=require('./disputes.receipts')

// Las cuentas bancarias vienen de la versión del cobro, nunca de la configuración actual.
async function freezeEffectAccounts(tx,scope,doc,kind){
  const [source]=await tx.$queryRaw`SELECT m.mode,m.account_id,v.bank_account_id FROM cash_bank_event_modes m
    JOIN cash_bank_method_versions v ON v.id=m.version_id WHERE m.event_id=${doc.eventId}::uuid FOR UPDATE OF m`
  if(!source||!['DIRECT','DEFERRED'].includes(source.mode))fail('DISPUTE_ORIGIN_BLOCKED','El cobro no conserva una clasificación bancaria verificable',409)
  if(kind==='PROVIDER_WITHHOLDING'&&source.mode!=='DEFERRED')fail('DISPUTE_PROVIDER_BALANCE','Este cobro no tiene saldo pendiente con un proveedor',409)
  const [policy]=await tx.$queryRaw`SELECT dispute_account_id,fee_account_id,revision FROM cash_dispute_settings WHERE company_id=${scope.companyId}::uuid FOR SHARE`
  const [previous]=await tx.$queryRaw`SELECT id,payload#>>'{accounting,disputeAccountId}' AS dispute_account_id FROM cash_dispute_events
    WHERE dispute_id=${doc.id}::uuid AND principal>0 AND kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING') ORDER BY created_at,id LIMIT 1`
  return {fundingAccountId:kind==='PROVIDER_WITHHOLDING'?source.account_id:source.bank_account_id,
    disputeAccountId:previous?(previous.dispute_account_id==null?null:Number(previous.dispute_account_id)):policy?.dispute_account_id??null,
    inheritedFromEffectId:previous?.id??null,feeAccountId:policy?.fee_account_id??null,policyRevision:policy?.revision??null}
}
async function providerRemaining(tx,eventId){
  const [r]=await tx.$queryRaw`SELECT e.amount-cash_dispute_provider_withheld(e.id)-coalesce((SELECT sum(abs(a.amount))
    FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=e.id AND s.status='POSTED'),0) AS amount
    FROM cash_money_events e WHERE e.id=${eventId}::uuid`
  return new Prisma.Decimal(r.amount)
}
async function confirmDisputeEffect(tx,scope,caseId,raw){
  authorize(scope,'movements');await requireAvailable(tx)
  fields(raw,['kind','principal','fee','effectiveOn','accountingDate','dateChangeReason','reference','evidence','expectedVersion','requestKey'])
  // La recuperación sumada a otro pago del proveedor va dentro de su liquidación; aquí solo el abono bancario independiente.
  if(!['BANK_DEBIT','PROVIDER_WITHHOLDING','BANK_RECOVERY'].includes(raw.kind))fail('DISPUTE_EFFECT_UNAVAILABLE','Este movimiento requiere su ruta de liquidación o compensación',409)
  const recovery=raw.kind==='BANK_RECOVERY'
  const principal=money(raw.principal),fee=money(raw.fee??'0')
  if(principal.add(fee).lte(0))fail('DISPUTE_MONEY_INVALID',recovery?'Indica el principal recuperado':'Indica el importe que el proveedor retiró o retuvo')
  if(recovery&&principal.lte(0))fail('DISPUTE_MONEY_INVALID','Indica el principal recuperado')
  const reference=text(raw.reference,'Referencia del movimiento',255)
  const payload={kind:raw.kind,principal:principal.toFixed(2),fee:fee.toFixed(2),effectiveOn:day(raw.effectiveOn,'Fecha del movimiento'),
    accountingDate:raw.accountingDate?day(raw.accountingDate,'Fecha contable'):null,dateChangeReason:raw.dateChangeReason?text(raw.dateChangeReason,'Motivo de la fecha contable',1000):null,
    reference,evidence:evidence(raw.evidence,reference),expectedVersion:raw.expectedVersion,caseId}
  if(payload.accountingDate&&payload.accountingDate!==payload.effectiveOn&&!payload.dateChangeReason)fail('DISPUTE_INPUT_INVALID','Explica por qué la fecha contable es diferente de la fecha del movimiento')
  await getDispute(tx,scope,caseId)
  const attempt=await beginDisputeCommand(tx,scope,'CONFIRM_EFFECT',raw,payload)
  if(attempt.replayed)return attempt.result
  const doc=await lockCase(tx,scope,caseId)
  if(!Number.isSafeInteger(payload.expectedVersion)||doc.version!==payload.expectedVersion)fail('DISPUTE_VERSION_CONFLICT','El expediente cambió. Revisa sus movimientos antes de continuar.',409)
  if(doc.status==='CANCELLED')fail('DISPUTE_STATE_CONFLICT','El expediente está cancelado',409)
  const origin=await originContext(tx,scope,doc.eventId)
  if(origin.issues.length)fail('DISPUTE_ORIGIN_BLOCKED',origin.issues[0],409)
  let plan=null
  if(recovery){
    const {planBankRecovery}=require('./disputes.domain'),resolutions=require('./disputes.resolutions')
    plan={lots:await resolutions.recoveryLots(tx,doc.id)}
    Object.assign(plan,planBankRecovery({withdrawn:doc.withdrawn,recovered:doc.recovered,lots:plan.lots,principal:principal.toFixed(2)}))
  }else{
    const [legacy]=await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_settlement_deductions x JOIN cash_settlements s ON s.id=x.settlement_id
      WHERE x.event_id=${doc.eventId}::uuid AND x.kind='CHARGEBACK' AND s.status='POSTED'
        AND NOT EXISTS(SELECT 1 FROM cash_dispute_events e WHERE e.deduction_id=x.id)) AS found`
    if(legacy.found)fail('DISPUTE_LEGACY_REVIEW_REQUIRED','Existe una retención anterior en una liquidación. Vincúlala antes de registrar otro retiro.',409)
    // Repetir un retiro tras una recuperación exige una compensación enlazada, aún no habilitada.
    if(new Prisma.Decimal(doc.withdrawn).add(principal).gt(doc.claimed))fail('DISPUTE_EFFECT_EXCEEDS','El retiro supera el principal del expediente. Revisa los movimientos anteriores.',409)
  }
  const accounting=await freezeEffectAccounts(tx,scope,doc,payload.kind)
  if(payload.kind==='PROVIDER_WITHHOLDING'&&principal.add(fee).gt(await providerRemaining(tx,doc.eventId)))fail('DISPUTE_PROVIDER_BALANCE','El proveedor ya no tiene ese saldo pendiente de liquidar',409)
  const id=randomUUID()
  await tx.$executeRaw`INSERT INTO cash_dispute_events(id,dispute_id,company_id,branch_id,kind,principal,fee,economic_on,reference,evidence,payload,actor_id)
    VALUES(${id}::uuid,${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${payload.kind},${payload.principal}::numeric,${payload.fee}::numeric,${payload.effectiveOn}::date,
      ${reference},${JSON.stringify(payload.evidence)}::jsonb,${JSON.stringify({accounting,requestedAccountingDate:payload.accountingDate,requestedDateReason:payload.dateChangeReason})}::jsonb,${scope.userId}::uuid)`
  if(plan?.lots.length)await require('./disputes.resolutions').applyRecoveryToLots(tx,scope,doc,id,plan.lots,await require('./disputes.resolutions').recoveryLots(tx,doc.id))
  await refreshOriginReceiptRestrictions(tx,scope,doc.eventId)
  await tx.$executeRaw`UPDATE cash_payment_disputes SET version=version+1 WHERE id=${doc.id}::uuid`
  await require('../../services/accounting/cashDisputePosting').postDisputeEffect(tx,scope,id,{accountingDate:payload.accountingDate??payload.effectiveOn,dateChangeReason:payload.dateChangeReason})
  return finishDisputeCommand(tx,attempt,await getDispute(tx,scope,doc.id))
}
module.exports={confirmDisputeEffect,freezeEffectAccounts}
