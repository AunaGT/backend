const {randomUUID}=require('node:crypto')
const {DateTime}=require('luxon')
const {money,referenceKey,fail,canonicalHash}=require('./disputes.domain')
const {validId,beginDisputeCommand,finishDisputeCommand,discoverDisputeResources,lockDisputeResources}=require('./disputes.boundary')
const {requireAvailable,originContext,getDispute}=require('./disputes.queries')
const {refreshOriginReceiptRestrictions}=require('./disputes.receipts')

function authorize(scope,action) {
  if(!validId(scope?.branchId)||!scope?.can?.[action])fail('DISPUTE_FORBIDDEN','No tienes permiso para esta acción de disputas',403)
}
function fields(raw,allowed) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k)))fail('DISPUTE_INPUT_INVALID','La solicitud contiene campos no permitidos')
}
function text(raw,label,max) {
  if(typeof raw!=='string'||!raw.trim()||raw.trim().length>max)fail('DISPUTE_INPUT_INVALID',`${label}: indica hasta ${max} caracteres`)
  return raw.trim()
}
function day(raw,label) {
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw)||!DateTime.fromISO(raw).isValid)fail('DISPUTE_INPUT_INVALID',`${label}: indica una fecha válida`)
  return raw
}
function evidence(raw,fallback) {
  if(raw==null)return {identifier:fallback}
  fields(raw,['identifier'])
  return {identifier:text(raw.identifier,'Identificador verificable',255)}
}
async function createDispute(tx,scope,raw) {
  authorize(scope,'manage');await requireAvailable(tx)
  fields(raw,['eventId','claimed','providerReference','reason','deadline','evidence','requestKey','replacesCaseId'])
  if(!validId(raw.eventId))fail('DISPUTE_INPUT_INVALID','Selecciona el cobro original')
  if(raw.replacesCaseId!=null&&!validId(raw.replacesCaseId))fail('DISPUTE_REPLACEMENT_INVALID','Selecciona el expediente cancelado que se corrige',409)
  const claimed=money(raw.claimed)
  if(claimed.lte(0))fail('DISPUTE_INPUT_INVALID','El principal reclamado debe ser mayor que cero')
  const providerReference=text(raw.providerReference,'Referencia del proveedor',120)
  const payload={eventId:raw.eventId.toLowerCase(),claimed:claimed.toFixed(2),providerReference,
    reason:text(raw.reason,'Motivo',1000),deadline:raw.deadline?day(raw.deadline,'Plazo de respuesta'):null,evidence:evidence(raw.evidence,providerReference),replacesCaseId:raw.replacesCaseId?.toLowerCase()??null}
  const attempt=await beginDisputeCommand(tx,scope,'CREATE',raw,payload)
  if(attempt.replayed)return attempt.result
  const resources=await discoverDisputeResources(tx,scope,{eventIds:[payload.eventId]})
  await lockDisputeResources(tx,scope,resources)
  const origin=await originContext(tx,scope,payload.eventId)
  if(!origin.eligible)fail('DISPUTE_ORIGIN_BLOCKED',origin.issues[0]||'El cobro ya no tiene principal disponible para reclamar',409)
  if(claimed.gt(origin.claimable))fail('DISPUTE_COVERAGE_EXCEEDED','El reclamo supera el principal disponible del cobro',409)
  const reference=referenceKey(providerReference)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-dispute-reference',attempt.companyId,origin.methodId,reference])},0))::text`
  if(payload.replacesCaseId) {
    const [previous]=await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE id=${payload.replacesCaseId}::uuid AND company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid
      AND payment_method_id=${origin.methodId} AND provider_reference_key=${reference} AND status='CANCELLED'
      AND NOT EXISTS(SELECT 1 FROM cash_payment_disputes c WHERE c.replaces_dispute_id=${payload.replacesCaseId}::uuid)`
    if(!previous)fail('DISPUTE_REPLACEMENT_INVALID','El expediente cancelado no corresponde a esta referencia o ya fue reemplazado',409)
  } else {
    const [previous]=await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${origin.methodId} AND provider_reference_key=${reference} AND status='CANCELLED'`
    if(previous)fail('DISPUTE_REPLACEMENT_REQUIRED','Esta referencia tiene un expediente cancelado. Selecciona el expediente que vas a corregir para conservar su historial.',409)
  }
  const [duplicate]=await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${origin.methodId} AND provider_reference_key=${reference} AND status<>'CANCELLED'`
  if(duplicate)fail('DISPUTE_REFERENCE_EXISTS','Esta referencia del proveedor ya tiene un expediente',409)
  const id=randomUUID()
  await tx.$executeRaw`INSERT INTO cash_payment_disputes(id,company_id,branch_id,event_id,customer_id,payment_method_id,currency_code,claimed,provider_reference,provider_reference_key,reason,deadline,created_by_id,replaces_dispute_id)
    VALUES(${id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${origin.eventId}::uuid,${origin.customerId}::uuid,${origin.methodId},${origin.currencyCode},${payload.claimed}::numeric,${providerReference},${reference},${payload.reason},${payload.deadline}::date,${scope.userId}::uuid,${payload.replacesCaseId}::uuid)`
  await tx.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,evidence,payload,accounting_status,actor_id)
    VALUES(${id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,'COMMUNICATION',${JSON.stringify(payload.evidence)}::jsonb,${JSON.stringify({action:'CREATED',reason:payload.reason})}::jsonb,'ZERO',${scope.userId}::uuid)`
  await refreshOriginReceiptRestrictions(tx,scope,origin.eventId)
  return finishDisputeCommand(tx,attempt,await getDispute(tx,scope,id))
}
async function disputePolicy(db,scope,{lock=false}={}) {
  const {Prisma}=require('@prisma/client')
  const [p]=await db.$queryRaw`SELECT owner_self_review,revision FROM cash_dispute_settings WHERE company_id=${scope.companyId}::uuid ${lock?Prisma.sql`FOR SHARE`:Prisma.empty}`
  return {ownerSelfReview:!!p?.owner_self_review,revision:p?.revision||0}
}
function parseAction(doc,kind,raw) {
  fields(raw,kind==='RESULT'?['won','lost','reason']:['reason'])
  const payload={reason:text(raw.reason,'Motivo',1000)}
  if(kind==='RESULT') {
    const won=money(raw.won),lost=money(raw.lost)
    if(!won.add(lost).eq(doc.claimed))fail('DISPUTE_RESULT_INVALID','La parte ganada y la perdida deben sumar el principal reclamado')
    Object.assign(payload,{won:won.toFixed(2),lost:lost.toFixed(2)})
    if(!['OPEN','SUBMITTED'].includes(doc.status))fail('DISPUTE_STATE_CONFLICT','Reabre el expediente antes de registrar otra decisión del proveedor',409)
  } else if(kind==='SUBMIT') {
    if(doc.status!=='OPEN')fail('DISPUTE_STATE_CONFLICT','El expediente ya no está abierto para presentar la respuesta',409)
  } else if(kind==='CANCEL') {
    if(!['OPEN','SUBMITTED'].includes(doc.status)||money(doc.withdrawn).gt(doc.recovered)||money(doc.fees).gt(0)||money(doc.disposed).gt(0)||money(doc.charged).gt(0))fail('DISPUTE_STATE_CONFLICT','Resuelve los movimientos, comisiones y cargos vinculados antes de cancelar',409)
  } else if(kind==='REOPEN') {
    if(!['WON','PARTIALLY_LOST','LOST'].includes(doc.status))fail('DISPUTE_STATE_CONFLICT','Este expediente no tiene un resultado que se pueda reabrir',409)
  } else fail('DISPUTE_ACTION_INVALID','Selecciona una acción válida para el expediente')
  return payload
}
async function previewDisputeAction(db,scope,caseId,raw,{stored=false}={}) {
  if(!scope?.can?.manage&&!scope?.can?.resolve)fail('DISPUTE_FORBIDDEN','No tienes permiso para preparar esta revisión',403)
  fields(raw,['kind','payload','expectedVersion','requestKey','previewKey'])
  const doc=await getDispute(db,scope,caseId)
  if(!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion!==doc.version)fail('DISPUTE_VERSION_CONFLICT','El expediente cambió. Revisa su estado actual.',409)
  const policy=await disputePolicy(db,scope)
  if(['DISPOSITION','FORGIVE','CORRECT'].includes(raw.kind)) {
    // Al aprobar se recalcula desde lo que pidió la persona, conservando la fecha de emisión de la propuesta.
    const p=raw.payload||{},resolutions=require('./disputes.resolutions')
    if(doc.status==='CANCELLED')fail('DISPUTE_STATE_CONFLICT','El expediente está cancelado',409)
    const r=raw.kind==='DISPOSITION'
      ?await resolutions.previewDisposition(db,scope,doc,stored?{customerPrincipal:p.customerPrincipal,absorbedPrincipal:p.absorbedPrincipal,reason:p.reason,...(p.dueOn?{dueOn:p.dueOn}:{})}:p,{issuedOn:stored?p.issuedOn:undefined})
      :await resolutions.previewAdjustment(db,scope,doc,raw.kind,stored?{lotId:p.lotId,amount:p.amount,reason:p.reason}:p)
    if(stored&&raw.kind!=='DISPOSITION')r.payload.issuedOn=p.issuedOn
    const base={caseId:doc.id,version:doc.version,status:doc.status,claimed:doc.claimed,withdrawn:doc.withdrawn,recovered:doc.recovered,fees:doc.fees,disposed:doc.disposed,policy,...r.base}
    return {baseKey:canonicalHash(base),previewKey:canonicalHash({base,kind:raw.kind,payload:r.payload}),version:doc.version,kind:raw.kind,payload:r.payload,
      before:{status:doc.status,won:doc.won,lost:doc.lost,charged:doc.charged},after:r.after,issues:r.issues}
  }
  const payload=parseAction(doc,raw.kind,raw.payload)
  if(raw.kind==='REOPEN') {
    const origin=await originContext(db,scope,doc.eventId)
    const required=money(doc.claimed).sub(money(doc.withdrawn).sub(doc.recovered))
    if(required.gt(origin.claimable))fail('DISPUTE_COVERAGE_EXCEEDED','Otro reclamo o devolución ya utiliza parte de este principal',409)
  }
  const base={caseId:doc.id,version:doc.version,status:doc.status,claimed:doc.claimed,withdrawn:doc.withdrawn,recovered:doc.recovered,fees:doc.fees,disposed:doc.disposed,policy}
  return {baseKey:canonicalHash(base),previewKey:canonicalHash({base,kind:raw.kind,payload}),version:doc.version,kind:raw.kind,payload,
    before:{status:doc.status,won:doc.won,lost:doc.lost,charged:doc.charged},
    after:{status:raw.kind==='RESULT'?(money(payload.lost).isZero()?'WON':money(payload.won).isZero()?'LOST':'PARTIALLY_LOST'):({SUBMIT:'SUBMITTED',CANCEL:'CANCELLED',REOPEN:'OPEN'})[raw.kind],won:payload.won??'0.00',lost:payload.lost??'0.00',charged:doc.charged},issues:[]}
}
async function lockCase(tx,scope,caseId) {
  const doc=await getDispute(tx,scope,caseId)
  await lockDisputeResources(tx,scope,await discoverDisputeResources(tx,scope,{eventIds:[doc.eventId]}))
  await tx.$queryRaw`SELECT id FROM cash_payment_disputes WHERE id=${doc.id}::uuid FOR UPDATE`
  return getDispute(tx,scope,caseId)
}
async function proposeDisputeAction(tx,scope,caseId,raw) {
  authorize(scope,'manage');await requireAvailable(tx)
  fields(raw,['kind','payload','expectedVersion','requestKey','previewKey'])
  const attempt=await beginDisputeCommand(tx,scope,'PROPOSE',raw,{caseId,kind:raw.kind,payload:raw.payload,expectedVersion:raw.expectedVersion,previewKey:raw.previewKey})
  if(attempt.replayed)return attempt.result
  await lockCase(tx,scope,caseId)
  const preview=await previewDisputeAction(tx,scope,caseId,raw)
  if(raw.previewKey!==preview.previewKey)fail('DISPUTE_PREVIEW_CHANGED','Revisa el efecto actualizado antes de enviar la propuesta',409)
  const id=randomUUID()
  await tx.$executeRaw`INSERT INTO cash_dispute_proposals(id,dispute_id,company_id,branch_id,kind,payload,preview_key,expected_version,proposed_by_id)
    VALUES(${id}::uuid,${caseId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${preview.kind},${JSON.stringify(preview.payload)}::jsonb,${preview.previewKey},${preview.version},${scope.userId}::uuid)`
  return finishDisputeCommand(tx,attempt,{id,caseId,kind:preview.kind,payload:preview.payload,status:'PENDING',expectedVersion:preview.version})
}
async function decideDisputeProposal(tx,scope,caseId,proposalId,raw) {
  authorize(scope,'resolve');await requireAvailable(tx)
  fields(raw,['decision','expectedVersion','requestKey','reason','selfReviewReason'])
  if(!validId(proposalId)||!['APPROVE','REJECT'].includes(raw.decision))fail('DISPUTE_INPUT_INVALID','Selecciona una decisión válida')
  const decisionReason=raw.reason?text(raw.reason,'Motivo de la decisión',1000):null
  if(raw.decision==='REJECT'&&!decisionReason)fail('DISPUTE_INPUT_INVALID','Indica el motivo del rechazo')
  const selfReviewReason=raw.selfReviewReason?text(raw.selfReviewReason,'Motivo de revisión excepcional',1000):null
  const attempt=await beginDisputeCommand(tx,scope,'DECIDE',raw,{caseId,proposalId,decision:raw.decision,expectedVersion:raw.expectedVersion,decisionReason,selfReviewReason})
  if(attempt.replayed)return attempt.result
  const doc=await lockCase(tx,scope,caseId)
  const [proposal]=await tx.$queryRaw`SELECT * FROM cash_dispute_proposals WHERE id=${proposalId}::uuid AND dispute_id=${doc.id}::uuid FOR UPDATE`
  if(!proposal)fail('DISPUTE_NOT_FOUND','Propuesta no encontrada',404)
  if(proposal.status!=='PENDING'||doc.version!==raw.expectedVersion)fail('DISPUTE_VERSION_CONFLICT','La propuesta o el expediente cambió. Revisa su estado.',409)
  const [actor]=await tx.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_dispute_events WHERE dispute_id=${doc.id}::uuid AND actor_id=${scope.userId}::uuid AND kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY')) AS involved`
  const involved=proposal.proposed_by_id===scope.userId||actor.involved
  const policy=await disputePolicy(tx,scope,{lock:true})
  if(involved&&!(scope.isAdmin&&policy.ownerSelfReview&&selfReviewReason))fail('DISPUTE_INDEPENDENT_REVIEW_REQUIRED','Otra persona autorizada debe revisar esta propuesta',409)
  let preview
  // Recuperar del cliente (cancelar su saldo o emitirle un cargo) exige el permiso específico de cargo.
  if(raw.decision==='APPROVE'&&proposal.kind==='DISPOSITION'&&money(proposal.payload?.customerPrincipal??'0').gt(0)&&!scope.can?.charge)fail('DISPUTE_FORBIDDEN','Aprobar un cargo al cliente requiere el permiso de cargos por disputa',403)
  // Condonar o corregir exige además ajustes de cartera, y el de cargos si toca lo que se cobra al cliente.
  if(raw.decision==='APPROVE'&&['FORGIVE','CORRECT'].includes(proposal.kind)&&(!scope.can?.adjust||(proposal.payload?.lotKind!=='ABSORBED'&&!scope.can?.charge)))fail('DISPUTE_FORBIDDEN','Esta corrección requiere permisos de ajuste de cartera y de cargos por disputa',403)
  if(raw.decision==='APPROVE') {
    preview=await previewDisputeAction(tx,scope,caseId,{kind:proposal.kind,payload:proposal.payload,expectedVersion:proposal.expected_version},{stored:true})
    if(preview.previewKey!==proposal.preview_key)fail('DISPUTE_PREVIEW_CHANGED','La base o la política cambió. Prepara una nueva propuesta.',409)
  }
  await tx.$executeRaw`UPDATE cash_dispute_proposals SET status=${raw.decision==='APPROVE'?'APPROVED':'REJECTED'},decided_by_id=${scope.userId}::uuid,decided_at=clock_timestamp(),decision_reason=${decisionReason||selfReviewReason},self_review=${involved} WHERE id=${proposal.id}::uuid`
  if(preview) {
    // Los lotes exigen la versión que revisó la propuesta: se crean antes de avanzar el expediente.
    const resolutions=require('./disputes.resolutions'),approved={...proposal,payload:preview.payload}
    const applied=proposal.kind==='DISPOSITION'?await resolutions.applyApprovedDisposition(tx,scope,doc,approved)
      :['FORGIVE','CORRECT'].includes(proposal.kind)?(await resolutions.applyApprovedAdjustment(tx,scope,doc,approved),true):null
    await tx.$executeRaw`UPDATE cash_payment_disputes SET status=${preview.after.status},won=${preview.after.won}::numeric,lost=${preview.after.lost}::numeric,version=version+1 WHERE id=${doc.id}::uuid`
    await tx.$executeRaw`INSERT INTO cash_dispute_events(dispute_id,company_id,branch_id,kind,payload,accounting_status,actor_id)
      VALUES(${doc.id}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,'STATUS',${JSON.stringify({proposalId,kind:proposal.kind,status:preview.after.status,...preview.payload,selfReview:involved,selfReviewReason})}::jsonb,'ZERO',${scope.userId}::uuid)`
    await refreshOriginReceiptRestrictions(tx,scope,doc.eventId)
    if(applied&&await require('./bankMethods').accountingEnabled(tx,scope.companyId))
      await require('../../services/accounting/cashDisputePosting').postDisputeDisposition(tx,scope,proposal.id,{accountingDate:preview.payload.issuedOn})
  }
  return finishDisputeCommand(tx,attempt,await getDispute(tx,scope,doc.id))
}
module.exports={authorize,fields,text,day,evidence,createDispute,disputePolicy,previewDisputeAction,proposeDisputeAction,decideDisputeProposal,lockCase}
