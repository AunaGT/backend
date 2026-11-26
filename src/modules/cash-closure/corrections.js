const { Prisma, JournalSourceType } = require('@prisma/client')
const { createHash } = require('node:crypto')
const { DateTime } = require('luxon')
const fail = (status,message) => { throw Object.assign(new Error(message),{status}) }
const money = v => {
  if (!['string','number'].includes(typeof v)||!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(v))) fail(400,'Ingresa importes no negativos con hasta dos decimales')
  const n=new Prisma.Decimal(String(v));if(n.gt('9999999999.99')) fail(400,'El importe excede el límite permitido');return n
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sum = values => values.reduce((a,v)=>a.add(String(v)),new Prisma.Decimal(0))
function only(input,fields) { if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k))) fail(400,'La solicitud contiene campos no permitidos') }
function calculateCorrection(base,input) {
  only(input,['reason','accountingDate','previousCorrectionId','lines','denominations','requestKey','previewKey'])
  const reason=typeof input.reason==='string'?input.reason.trim():''
  if(!reason||reason.length>1000) fail(400,'Indica el motivo en hasta 1000 caracteres')
  if(typeof input.accountingDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.accountingDate)||!DateTime.fromISO(input.accountingDate).isValid) fail(400,'Elige una fecha contable válida')
  if(input.previousCorrectionId!==base.previousCorrectionId) fail(409,'Existe una corrección aprobada más reciente. Revisa la nueva base')
  if(!Array.isArray(input.lines)||input.lines.length!==base.lines.length) fail(400,'Indica el importe correcto de cada medio original')
  const seen=new Set(),byId=new Map(base.lines.map(l=>[l.closurePaymentId,l]))
  const lines=input.lines.map(row=>{
    only(row,['closurePaymentId','correctedActual']);const old=byId.get(row.closurePaymentId)
    if(!old||seen.has(row.closurePaymentId)) fail(400,'Medio original desconocido o repetido');seen.add(row.closurePaymentId)
    const actual=money(row.correctedActual)
    return {...old,correctedActual:actual.toFixed(2),delta:actual.sub(old.previousActual).toFixed(2),correctedDifference:actual.sub(old.originalExpected).toFixed(2)}
  }).sort((a,b)=>a.closurePaymentId-b.closurePaymentId)
  if(lines.every(l=>new Prisma.Decimal(l.delta).isZero())) fail(400,'Cambia al menos un importe declarado')
  const raw=input.denominations??[],keys=new Set()
  if(!Array.isArray(raw)||raw.length>100) fail(400,'Desglose de billetes y monedas inválido')
  const denominations=raw.map(row=>{
    only(row,['denomination','quantity','type']);const d=money(row.denomination),key=`${row.type}:${d.toFixed(2)}`
    if(!['Billete','Moneda'].includes(row.type)||d.isZero()||keys.has(key)||!Number.isSafeInteger(row.quantity)||row.quantity<0||row.quantity>10000000) fail(400,'Denominación o cantidad inválida')
    keys.add(key);return {denomination:d.toFixed(2),quantity:row.quantity,type:row.type,subtotal:d.mul(row.quantity).toFixed(2)}
  })
  const cash=lines.filter(l=>l.kind==='CASH')
  if(raw.length&&(!cash.length||!sum(denominations.map(d=>d.subtotal)).eq(sum(cash.map(l=>l.correctedActual))))) fail(400,'Los billetes y monedas deben coincidir con el efectivo corregido')
  return {reason,accountingDate:input.accountingDate,previousCorrectionId:base.previousCorrectionId,lines,denominations,cashDelta:sum(cash.map(l=>l.delta)).toFixed(2),correctedDifference:sum(lines.map(l=>l.correctedDifference)).toFixed(2)}
}
const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const idValid=id=>typeof id==='string'&&uuid.test(id)
async function available(db) {
  if(!JournalSourceType?.CASH_CLOSURE_CORRECTION)return false
  return (await db.$queryRaw`SELECT to_regclass('cash_closure_corrections') IS NOT NULL AND to_regclass('cash_closure_correction_lines') IS NOT NULL AND to_regclass('cash_closure_correction_commands') IS NOT NULL AS ok`)[0]?.ok===true
}
const reader=scope=>({...scope,branchIds:scope.branchIds||[scope.branchId],mode:scope.viewTeam?'team':'mine'})
async function parent(db,scope,id,lock=false) {
  if(!idValid(id))fail(404,'Arqueo no encontrado')
  await require('./readQueries').assertReadable(db,reader(scope),id)
  const [c]=await db.$queryRaw`SELECT c.*,s.id AS session_id,s.opened_by_id AS responsible_id FROM cash_closures c JOIN branches b ON b.id=c.branch_id
    LEFT JOIN cash_register_sessions s ON s.cash_closure_id=c.id WHERE c.id=${id}::uuid AND c.branch_id=ANY(${scope.branchIds||[scope.branchId]}::uuid[]) AND b.company_id=${scope.companyId}::uuid ${lock?Prisma.sql`FOR UPDATE OF c`:Prisma.empty}`
  if(!c)fail(404,'Arqueo no encontrado');return c
}
async function baseFor(db,c) {
  const latest=(await db.$queryRaw`SELECT id,sequence FROM cash_closure_corrections WHERE closure_id=${c.id}::uuid AND status='APPROVED' ORDER BY sequence DESC LIMIT 1`)[0]
  const payments=await db.$queryRaw`SELECT id,payment_method_id,theoretical_amount::text,actual_amount::text FROM cash_closure_payments WHERE cash_closure_id=${c.id}::uuid ORDER BY id`
  const previous=latest?await db.$queryRaw`SELECT closure_payment_id,corrected_actual::text FROM cash_closure_correction_lines WHERE correction_id=${latest.id}::uuid`:[]
  const snapshot=c.calculation_snapshot,frozen=snapshot?.payment_breakdowns
  let issue=!['Aprobado','Cerrado'].includes(c.status)?'Solo se corrigen arqueos finalizados':null
  if(!/^[A-Z]{3}$/.test(snapshot?.currency_code||'')||!Array.isArray(frozen)||!payments.length||frozen.length!==payments.length||new Set(frozen.map(l=>l.id)).size!==payments.length)issue='Este arqueo histórico no tiene moneda y desglose congelados verificables'
  const lines=payments.map(p=>{
    const f=Array.isArray(frozen)?frozen.find(l=>l.id===p.id):null,prev=previous.find(l=>l.closure_payment_id===p.id)
    if(!f||f.payment_method_id!==p.payment_method_id||!['CASH','BANK'].includes(f.settlement_kind)||typeof f.payment_method_name!=='string'||!f.payment_method_name.trim()||latest&&!prev)issue='Este arqueo histórico no tiene moneda y desglose congelados verificables'
    return {closurePaymentId:p.id,paymentMethodId:p.payment_method_id,name:f?.payment_method_name||'Medio histórico',kind:f?.settlement_kind||'UNKNOWN',originalExpected:p.theoretical_amount,previousActual:prev?.corrected_actual??p.actual_amount}
  })
  const base={id:c.id,closureNumber:c.closure_number,currency:snapshot?.currency_code||null,previousCorrectionId:latest?.id||null,sequence:latest?.sequence||0,lines,eligible:!issue,issue}
  return {...base,baseKey:hash({id:c.id,snapshot,original:payments,previousCorrectionId:base.previousCorrectionId,lines})}
}
async function selfReview(db,scope,c,proposerId) {
  return [proposerId,c.cashier_id,c.responsible_id].includes(scope.userId)||!!c.session_id&&await require('../../services/cashSharedSessions').participated(db,c.session_id,scope.userId)
}
async function correctionContext(db,scope,id) {
  const c=await parent(db,scope,id)
  if(!await available(db))return {available:false,eligible:false,issue:'Las correcciones todavía no están disponibles',lines:[],can:{propose:false}}
  const base=await baseFor(db,c)
  return {...base,available:true,can:{propose:!!scope.canPropose&&base.eligible},accountingEnabled:await require('./bankMethods').accountingEnabled(db,scope.companyId)}
}
async function previewCorrection(db,scope,id,input) {
  if(!scope.canPropose)fail(403,'No tienes permiso para proponer correcciones')
  const ctx=await correctionContext(db,scope,id)
  if(!ctx.available||!ctx.eligible)fail(409,ctx.issue)
  const calculation=calculateCorrection(ctx,input)
  const accounting=await require('../../services/accounting/cashClosurePosting').inspectChain(db,scope,id,calculation)
  const custodyComparison=await compareHandover(db,scope,id,calculation.lines)
  return {...calculation,currency:ctx.currency,baseKey:ctx.baseKey,accounting,custodyComparison,previewKey:hash({baseKey:ctx.baseKey,calculation,accounting,custodyComparison})}
}
async function compareHandover(db,scope,id,lines){
  const cash=lines.filter(l=>l.kind==='CASH')
  if(!cash.length)return null
  const [h]=await db.$queryRaw`SELECT h.delivered_amount::text,h.retained_amount::text,s.id AS session_id,s.opened_by_id FROM cash_turn_handovers h JOIN cash_register_sessions s ON s.id=h.cash_register_session_id
    WHERE s.cash_closure_id=${id}::uuid AND h.company_id=${scope.companyId}::uuid AND h.branch_id=ANY(${scope.branchIds||[scope.branchId]}::uuid[])`
  if(!h)return null
  const recorded=sum([h.delivered_amount,h.retained_amount]),corrected=sum(cash.map(l=>l.correctedActual))
  return {sessionId:h.session_id,recorded:recorded.toFixed(2),corrected:corrected.toFixed(2),difference:corrected.sub(recorded).toFixed(2),canOpen:!!scope.canViewHandoverTeam||h.opened_by_id===scope.userId&&!!scope.canViewOwnHandover}
}
async function command(tx,scope,closureId,action,input,work) {
  if(!idValid(input?.requestKey))fail(400,'Falta la clave de la solicitud; vuelve a intentarlo')
  if(!scope.companyId||!scope.branchId||!scope.userId)fail(403,'Selecciona una empresa y sucursal')
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope.companyId}),hashtext(${scope.userId+action+input.requestKey}))`
  const digest=hash({closureId,input})
  const [receipt]=await tx.$queryRaw`SELECT content_hash,result FROM cash_closure_correction_commands WHERE company_id=${scope.companyId}::uuid AND actor_id=${scope.userId}::uuid AND action=${action} AND request_key=${input.requestKey}::uuid`
  if(receipt){
    await parent(tx,scope,closureId)
    if(receipt.content_hash!==digest)fail(409,'Esta solicitud ya se usó con otro contenido')
    return receipt.result
  }
  const result=JSON.parse(JSON.stringify(await work()))
  await tx.$executeRaw`INSERT INTO cash_closure_correction_commands(company_id,actor_id,correction_id,action,request_key,content_hash,result)
    VALUES(${scope.companyId}::uuid,${scope.userId}::uuid,${result.id}::uuid,${action},${input.requestKey}::uuid,${digest},${JSON.stringify(result)}::jsonb)`
  return result
}
async function proposeCorrection(tx,scope,id,input) {
  if(!scope.canPropose)fail(403,'No tienes permiso para proponer correcciones')
  if(!await available(tx))fail(409,'Las correcciones todavía no están disponibles')
  return command(tx,scope,id,'PROPOSE',input,async()=>{
    const c=await parent(tx,scope,id,true),preview=await previewCorrection(tx,scope,id,input)
    if(input.previewKey!==preview.previewKey)fail(409,'La información cambió. Revisa el resumen antes de enviar')
    const [doc]=await tx.$queryRaw`INSERT INTO cash_closure_corrections(company_id,branch_id,closure_id,previous_correction_id,currency_code,reason,accounting_date,proposed_by_id,base_key,content_hash,denominations)
      VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${c.id}::uuid,${preview.previousCorrectionId}::uuid,${preview.currency},${preview.reason},${preview.accountingDate}::date,${scope.userId}::uuid,${preview.baseKey},${hash(preview)},${JSON.stringify(preview.denominations)}::jsonb) RETURNING id`
    for(const l of preview.lines)await tx.$executeRaw`INSERT INTO cash_closure_correction_lines(correction_id,closure_payment_id,payment_method_id,payment_method_name,settlement_kind,original_expected,previous_actual,corrected_actual,delta,corrected_difference)
      VALUES(${doc.id}::uuid,${l.closurePaymentId},${l.paymentMethodId},${l.name},${l.kind},${l.originalExpected}::numeric,${l.previousActual}::numeric,${l.correctedActual}::numeric,${l.delta}::numeric,${l.correctedDifference}::numeric)`
    return getCorrection(tx,scope,id,doc.id)
  })
}
async function getCorrection(db,scope,id,correctionId) {
  const c=await parent(db,scope,id)
  if(!idValid(correctionId)||!await available(db))fail(404,'Corrección no encontrada')
  const [row]=await db.$queryRaw`SELECT x.*,p.name AS proposer_name,d.name AS decider_name,j.entry_number FROM cash_closure_corrections x JOIN users p ON p.id=x.proposed_by_id LEFT JOIN users d ON d.id=x.decided_by_id LEFT JOIN journal_entries j ON j.id=x.journal_entry_id
    WHERE x.id=${correctionId}::uuid AND x.closure_id=${id}::uuid AND x.company_id=${scope.companyId}::uuid AND x.branch_id=${c.branch_id}::uuid`
  if(!row)fail(404,'Corrección no encontrada')
  const lines=await db.$queryRaw`SELECT closure_payment_id AS "closurePaymentId",payment_method_id AS "paymentMethodId",payment_method_name AS name,settlement_kind AS kind,
    original_expected::text AS "originalExpected",previous_actual::text AS "previousActual",corrected_actual::text AS "correctedActual",delta::text,corrected_difference::text AS "correctedDifference"
    FROM cash_closure_correction_lines WHERE correction_id=${correctionId}::uuid ORDER BY closure_payment_id`
  const self=await selfReview(db,scope,c,row.proposed_by_id),policy=await require('./policy').resolvePolicy(db,scope.companyId,c.branch_id)
  const pending=row.status==='PENDING',base=await baseFor(db,c),stale=row.previous_correction_id!==base.previousCorrectionId
  return {id:row.id,closureId:id,closureNumber:c.closure_number,status:row.status,sequence:row.sequence,currency:row.currency_code,reason:row.reason,accountingDate:row.accounting_date.toISOString().slice(0,10),previousCorrectionId:row.previous_correction_id,
    proposedBy:row.proposed_by_id,proposedByName:row.proposer_name,proposedAt:row.proposed_at.toISOString(),updatedAt:row.updated_at.toISOString(),decidedByName:row.decider_name,decidedAt:row.decided_at?.toISOString()||null,decisionReason:row.decision_reason,selfReview:row.self_review,
    accountingStatus:row.accounting_status,journalEntryId:row.journal_entry_id,entryNumber:row.entry_number,denominations:row.denominations,lines,cashDelta:sum(lines.filter(l=>l.kind==='CASH').map(l=>l.delta)).toFixed(2),correctedDifference:sum(lines.map(l=>l.correctedDifference)).toFixed(2),stale,
    ...(pending&&scope.canReview?{accounting:await require('../../services/accounting/cashClosurePosting').inspectChain(db,scope,id,{cashDelta:sum(lines.filter(l=>l.kind==='CASH').map(l=>l.delta)).toFixed(2),accountingDate:row.accounting_date.toISOString().slice(0,10)})}:{}),
    custodyComparison:await compareHandover(db,scope,id,lines),
    can:{approve:pending&&!stale&&!!scope.canReview&&(!self||policy.owner_self_review),reject:pending&&!!scope.canReview&&(!self||policy.owner_self_review),cancel:pending&&!!scope.canPropose&&row.proposed_by_id===scope.userId},requiresSelfReviewReason:self}
}
async function listCorrections(db,scope,id,input={}) {
  await parent(db,scope,id)
  if(!await available(db))return {items:[],totalItems:0,page:1,pageSize:20}
  const page=Number(input.page??1),pageSize=Number(input.pageSize??20)
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)fail(400,'La paginación no es válida')
  const [count]=await db.$queryRaw`SELECT count(*)::int AS n FROM cash_closure_corrections WHERE closure_id=${id}::uuid`
  const rows=await db.$queryRaw`SELECT id,status,sequence,reason,proposed_at,accounting_status FROM cash_closure_corrections WHERE closure_id=${id}::uuid ORDER BY proposed_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`
  return {items:rows.map(r=>({id:r.id,status:r.status,sequence:r.sequence,reason:r.reason,proposedAt:r.proposed_at.toISOString(),accountingStatus:r.accounting_status})),totalItems:count.n,page,pageSize}
}
async function decideCorrection(tx,scope,id,correctionId,input) {
  if(!scope.canReview)fail(403,'No tienes permiso para revisar correcciones')
  if(!await available(tx))fail(409,'Las correcciones todavía no están disponibles')
  only(input,['action','expectedUpdatedAt','requestKey','reason'])
  if(!['APPROVE','REJECT'].includes(input.action)||!idValid(correctionId))fail(400,'Acción de revisión inválida')
  await require('../../services/accounting/core').lockAccountingCompany(tx,scope.companyId)
  return command(tx,scope,id,input.action,{...input,correctionId},async()=>{
    const c=await parent(tx,scope,id,true),doc=await getCorrection(tx,scope,id,correctionId)
    if(doc.status!=='PENDING'||doc.updatedAt!==input.expectedUpdatedAt)fail(409,'Esta propuesta cambió o ya fue revisada')
    if(input.action==='APPROVE'&&doc.stale)fail(409,'Existe una corrección aprobada más reciente. Prepara otra propuesta')
    const self=await selfReview(tx,scope,c,doc.proposedBy),policy=await require('./policy').resolvePolicy(tx,scope.companyId,scope.branchId)
    if(self&&!policy.owner_self_review)fail(403,'Otra persona autorizada debe revisar esta corrección')
    const reason=typeof input.reason==='string'?input.reason.trim():''
    if(reason.length>1000||(!reason&&(self||input.action==='REJECT')))fail(400,'Indica el motivo de la decisión en hasta 1000 caracteres')
    const sequence=input.action==='APPROVE'?(await baseFor(tx,c)).sequence+1:null
    await tx.$executeRaw`UPDATE cash_closure_corrections SET status=${input.action==='APPROVE'?'APPROVED':'REJECTED'},sequence=${sequence},decided_by_id=${scope.userId}::uuid,decided_at=clock_timestamp(),decision_reason=${reason||null},self_review=${self},policy_snapshot=${JSON.stringify(policy)}::jsonb WHERE id=${correctionId}::uuid`
    if(input.action==='APPROVE'&&await require('./bankMethods').accountingEnabled(tx,scope.companyId))await require('../../services/accounting/cashClosurePosting').postClosureChain(tx,scope,id)
    return getCorrection(tx,scope,id,correctionId)
  })
}
async function cancelCorrection(tx,scope,id,correctionId,input) {
  if(!scope.canPropose)fail(403,'No tienes permiso para cancelar correcciones')
  if(!await available(tx))fail(409,'Las correcciones todavía no están disponibles')
  only(input,['requestKey','expectedUpdatedAt','reason'])
  return command(tx,scope,id,'CANCEL',{...input,correctionId},async()=>{
    await parent(tx,scope,id,true);const doc=await getCorrection(tx,scope,id,correctionId)
    if(!doc.can.cancel)fail(403,'Solo puedes cancelar tus propuestas pendientes')
    if(input.expectedUpdatedAt!==doc.updatedAt)fail(409,'La propuesta cambió')
    const reason=typeof input.reason==='string'?input.reason.trim():''
    if(!reason||reason.length>1000)fail(400,'Indica por qué cancelas esta propuesta')
    await tx.$executeRaw`UPDATE cash_closure_corrections SET status='CANCELLED',decided_by_id=${scope.userId}::uuid,decided_at=clock_timestamp(),decision_reason=${reason} WHERE id=${correctionId}::uuid`
    return getCorrection(tx,scope,id,correctionId)
  })
}
module.exports={calculateCorrection,hash,sum,only,fail,available,parent,baseFor,correctionContext,previewCorrection,proposeCorrection,getCorrection,listCorrections,decideCorrection,cancelCorrection}
