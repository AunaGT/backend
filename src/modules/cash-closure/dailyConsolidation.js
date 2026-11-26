const { createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const D = value => new Prisma.Decimal(String(value ?? 0))
const money = value => D(value).toFixed(2)
const iso = value => value ? new Date(value).toISOString() : null
const STATE = { Pendiente: 'PENDING_REVIEW', Reconteo: 'RECOUNT', Aprobado: 'FINALIZED', Rechazado: 'REJECTED', Validado: 'PENDING_REVIEW' }
const BLOCKER = { OPERATING: 'El turno sigue operando: termínalo en el POS.', PENDING_COUNT: 'El turno terminó sin arqueo: falta contarlo.', PENDING_REVIEW: 'El arqueo espera revisión: finalízalo o pide reconteo.', RECOUNT: 'El arqueo está en reconteo: falta el nuevo conteo.' }
const has = async (db, table) => (await db.$queryRaw`SELECT to_regclass(${table}) IS NOT NULL AS ok`)[0]?.ok === true

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) fail(400, 'CASH_DAY_INPUT', 'La fecha operativa no es válida (AAAA-MM-DD)')
  return value
}
async function dailyAvailable(db) { return has(db, 'cash_daily_consolidations') }

// Vista del día: todo sale de los documentos existentes (turnos, arqueos, eventos, entregas, avisos, liquidaciones); no recalcula ventas.
async function compute(db, scope, date) {
  const turns = await db.$queryRaw`SELECT s.id,s.status,s.register_type,s.operation_mode,s.cash_register_id,s.opening_float,s.opening_inherited_amount,s.opened_at,s.closed_at,s.opened_by_id,r.name AS register_name,u.name AS responsible_name,
    c.id AS closure_id,c.closure_number,c.status AS closure_status,c.difference,(to_jsonb(c)->>'review_result') AS review_result,(to_jsonb(c)->'review_classification') AS classification
    FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN users u ON u.id=s.opened_by_id LEFT JOIN cash_closures c ON c.id=s.cash_closure_id
    WHERE r.branch_id=${scope.branchId}::uuid AND r.branch_id IN(SELECT id FROM branches WHERE company_id=${scope.companyId}::uuid) AND s.business_date=${date}::date AND s.money_event_version=1 ORDER BY s.opened_at,s.id`
  const ids = turns.map(t => t.id)
  for (const turn of turns) if (turn.operation_mode === 'SHARED') turn.participants = await require('../../services/cashSharedSessions').participants(db, turn.id)
  const view = turns.map(t => {
    const state = t.status === 'OPEN' ? 'OPERATING' : !t.closure_id ? 'PENDING_COUNT' : STATE[t.closure_status] || 'PENDING_REVIEW'
    return { id: t.id, register_name: t.register_name, register_type: t.register_type, responsible_id:t.opened_by_id, responsible_name: t.responsible_name, opened_at: iso(t.opened_at), closed_at: iso(t.closed_at),
      state, closure_id: t.closure_id, closure_number: t.closure_number, review_result: t.review_result, difference: t.closure_id ? money(t.difference) : null,
      ...(t.operation_mode === 'SHARED' ? { operation_mode: t.operation_mode, participants: t.participants } : {}) }
  })
  const blockers = view.filter(t => BLOCKER[t.state]).map(t => ({ code: t.state, sessionId: t.id, closureId: t.closure_id, register: t.register_name, message: `${t.register_name} · ${t.responsible_name}: ${BLOCKER[t.state]}` }))
  const events = ids.length ? await db.$queryRaw`SELECT e.id,e.cash_register_session_id,e.settlement_kind,e.source_type,e.direction,e.amount,e.payment_method_name FROM cash_money_events e WHERE e.cash_register_session_id=ANY(${ids}::uuid[])` : []
  const sum = rows => rows.reduce((s, e) => s.add(D(e.amount)), D(0))
  const cashEv = events.filter(e => e.settlement_kind === 'CASH')
  const commercial = ['SALE', 'CUSTOMER_PAYMENT', 'RETURN_SETTLEMENT']
  const handovers = ids.length && await has(db, 'cash_turn_handovers') ? await db.$queryRaw`SELECT coalesce(sum(delivered_amount),0) AS delivered,coalesce(sum(retained_amount),0) AS retained FROM cash_turn_handovers WHERE cash_register_session_id=ANY(${ids}::uuid[])` : [{ delivered: 0, retained: 0 }]
  const transit = ids.length && await has(db, 'cash_custody_transfers') ? await db.$queryRaw`SELECT count(*)::int AS count,coalesce(sum(t.amount),0) AS amount FROM cash_custody_transfers t LEFT JOIN cash_turn_handovers h ON h.id=t.handover_id
    WHERE t.status='PENDING' AND (t.origin_session_id=ANY(${ids}::uuid[]) OR h.cash_register_session_id=ANY(${ids}::uuid[]))` : [{ count: 0, amount: 0 }]
  // Diferencias aceptadas: solo el efectivo de los arqueos finalizados, por medio (un sobrante digital no compensa).
  const accepted = turns.filter(t => t.closure_status === 'Aprobado').reduce((s, t) => s.add((t.classification?.lines || []).filter(l => l.kind === 'CASH').reduce((a, l) => a.add(D(l.difference)), D(0))), D(0))
  const documents=ids.length&&await has(db,'cash_turn_handovers')?await db.$queryRaw`SELECT cash_register_session_id,delivered_amount,retained_amount FROM cash_turn_handovers WHERE cash_register_session_id=ANY(${ids}::uuid[])`:[]
  const floatEntries=ids.length&&await has(db,'cash_custody_entries')?await db.$queryRaw`SELECT e.*,h.cash_register_session_id AS origin_session_id,s.business_date::text AS origin_business_date,
    t.origin_kind,t.returns_transfer_id,coalesce(t.origin_session_id,parent.origin_session_id) AS transfer_origin_session_id,ts.business_date::text AS transfer_origin_business_date
    FROM cash_custody_entries e LEFT JOIN cash_turn_handovers h ON h.id=e.handover_id LEFT JOIN cash_register_sessions s ON s.id=h.cash_register_session_id
    LEFT JOIN cash_custody_transfers t ON t.id=e.transfer_id LEFT JOIN cash_custody_transfers parent ON parent.id=t.returns_transfer_id
    LEFT JOIN cash_register_sessions ts ON ts.id=coalesce(t.origin_session_id,parent.origin_session_id)
    WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid AND e.holder_kind='FLOAT' ORDER BY e.created_at,e.id`:[]
  const bridge=require('./dailyCashBridge').cashBridge({date,turns,events,handovers:documents,floatEntries,acceptedDifference:accepted.toFixed(2)})
  const cash = { bridge, opening: bridge.initial,
    received: money(sum(cashEv.filter(e => e.direction === 'IN' && commercial.includes(e.source_type)))),
    fundIn: money(sum(cashEv.filter(e => e.direction === 'IN' && e.source_type === 'PHYSICAL_MOVEMENT'))),
    custodyIn: money(sum(cashEv.filter(e => e.direction === 'IN' && e.source_type === 'CUSTODY_ENTRY'))),
    paidOut: money(sum(cashEv.filter(e => e.direction === 'OUT' && e.source_type !== 'CUSTODY_ENTRY'))),
    sentToCustody: money(sum(cashEv.filter(e => e.direction === 'OUT' && e.source_type === 'CUSTODY_ENTRY'))),
    delivered: money(handovers[0].delivered), retained: bridge.retainedFinal, acceptedDifference: money(accepted),
    inTransit: { count: transit[0].count, amount: money(transit[0].amount) } }
  const byMethod = Object.values(events.filter(e => e.settlement_kind === 'BANK').reduce((acc, e) => {
    const row = acc[e.payment_method_name] ||= { name: e.payment_method_name, amount: D(0) }
    row.amount = row.amount.add(e.direction === 'IN' ? D(e.amount) : D(e.amount).neg()); return acc
  }, {})).map(m => ({ name: m.name, amount: m.amount.toFixed(2) })).sort((a, b) => a.name.localeCompare(b.name))
  let toSettle = D(0)
  if (ids.length && await has(db, 'cash_settlements')) {
    const [r] = await db.$queryRaw`SELECT coalesce(sum(CASE WHEN e.direction='IN' THEN 1 ELSE -1 END*(e.amount-coalesce((SELECT sum(abs(a.amount)) FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=e.id AND s.status='POSTED'),0))),0) AS pending
      FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id WHERE m.mode='DEFERRED' AND e.cash_register_session_id=ANY(${ids}::uuid[])`
    toSettle = D(r.pending)
  }
  const closureIds = turns.filter(t => t.closure_id).map(t => t.closure_id)
  const entries = closureIds.length ? (await db.$queryRaw`SELECT entry_number FROM journal_entries WHERE company_id=${scope.companyId}::uuid AND source_type::text='CASH_CLOSURE' AND source_id=ANY(${closureIds.map(String)}::text[]) ORDER BY entry_number`).map(e => e.entry_number) : []
  const [{ legacy }] = await db.$queryRaw`SELECT count(*)::int AS legacy FROM cash_registers WHERE branch_id=${scope.branchId}::uuid AND active AND money_event_version=0`
  return { version: 2, businessDate: date, turns: view, blockers, cash, digital: { byMethod, toSettle: toSettle.toFixed(2) }, entries,
    legacyNotice: legacy ? `${legacy} caja${legacy === 1 ? '' : 's'} sin libro de movimientos sigue${legacy === 1 ? '' : 'n'} con el cierre del día anterior; sus importes no se mezclan aquí.` : null }
}

// Live information is never included in the stored snapshot or its content hash.
async function currentState(db,scope,date,snapshot) {
  let settlements = { count: 0, net: '0.00' }, pendingNotices = { count: 0, amount: '0.00', oldest: null }, toSettle = D(0), references=[]
  const ids=(snapshot.turns||[]).map(t=>t.id)
  if (await has(db, 'cash_settlements')) {
    const [r] = await db.$queryRaw`SELECT count(*)::int AS count,coalesce(sum(s.net),0) AS net FROM cash_settlements s JOIN cash_bank_deposits d ON d.id=s.deposit_id
      WHERE s.branch_id=${scope.branchId}::uuid AND s.status='POSTED' AND d.deposited_on=${date}::date`
    settlements = { count: r.count, net: money(r.net) }
    if(ids.length){
      const [p]=await db.$queryRaw`SELECT coalesce(sum(CASE WHEN e.direction='IN' THEN 1 ELSE -1 END*(e.amount-coalesce((SELECT sum(abs(a.amount)) FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=e.id AND s.status='POSTED'),0))),0) AS pending
        FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id WHERE m.mode='DEFERRED' AND e.cash_register_session_id=ANY(${ids}::uuid[]) AND e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid`
      toSettle=D(p.pending)
      references=await db.$queryRaw`SELECT DISTINCT s.id,d.reference,d.deposited_on::text AS deposited_on FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id
        JOIN cash_bank_deposits d ON d.id=s.deposit_id JOIN cash_money_events e ON e.id=a.event_id WHERE s.status='POSTED' AND e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid AND e.cash_register_session_id=ANY(${ids}::uuid[]) ORDER BY d.deposited_on::text,d.reference,s.id`
    }
  }
  if (await has(db, 'cash_payment_notices')) {
    const [r] = await db.$queryRaw`SELECT count(*)::int AS count,coalesce(sum(amount),0) AS amount,min(reported_paid_on)::text AS oldest FROM cash_payment_notices WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND status='PENDING'`
    pendingNotices = { count: r.count, amount: money(r.amount), oldest: r.oldest }
  }
  const closureIds=(snapshot.turns||[]).map(t=>t.closure_id).filter(Boolean)
  const corrections=closureIds.length&&await has(db,'cash_closure_corrections')?await db.$queryRaw`SELECT x.id,x.closure_id,c.closure_number,x.sequence,x.currency_code,x.reason,x.decided_at,x.accounting_date::text,x.accounting_status,j.entry_number,
    (SELECT coalesce(sum(l.delta),0)::text FROM cash_closure_correction_lines l WHERE l.correction_id=x.id AND l.settlement_kind='CASH') AS cash_delta,
    (SELECT coalesce(sum(l.corrected_difference),0)::text FROM cash_closure_correction_lines l WHERE l.correction_id=x.id) AS corrected_difference
    FROM cash_closure_corrections x JOIN cash_closures c ON c.id=x.closure_id LEFT JOIN journal_entries j ON j.id=x.journal_entry_id
    WHERE x.company_id=${scope.companyId}::uuid AND x.branch_id=${scope.branchId}::uuid AND x.status='APPROVED' AND x.closure_id=ANY(${closureIds}::uuid[]) ORDER BY x.decided_at,x.id`:[]
  // Disputas con fecha económica de este día: consulta posterior, fuera del resumen finalizado y sin sumarse al efectivo.
  let disputes=null
  if(await has(db,'cash_dispute_events')){
    const rows=await db.$queryRaw`SELECT e.id,e.dispute_id,e.kind,e.principal::text,e.fee::text,e.settlement_id,e.accounting_status,d.provider_reference,d.currency_code
      FROM cash_dispute_events e JOIN cash_payment_disputes d ON d.id=e.dispute_id WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid
      AND e.economic_on=${date}::date AND e.kind IN('BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING','BANK_RECOVERY','PROVIDER_RECOVERY','COMPENSATION') ORDER BY e.created_at,e.id`
    const [charges]=await db.$queryRaw`SELECT count(*)::int AS count,coalesce(sum(amount),0)::text AS amount FROM customer_dispute_charges WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND issued_on=${date}::date`
    const sum=kinds=>money(rows.filter(r=>kinds.includes(r.kind)).reduce((s,r)=>s.add(r.principal),D(0)))
    disputes={withdrawn:sum(['BANK_DEBIT','PROVIDER_WITHHOLDING','LEGACY_WITHHOLDING']),recovered:sum(['BANK_RECOVERY','PROVIDER_RECOVERY']),fees:money(rows.reduce((s,r)=>s.add(r.fee),D(0))),
      chargesIssued:{count:charges.count,amount:money(charges.amount)},
      items:rows.map(r=>({id:r.id,disputeId:r.dispute_id,kind:r.kind,principal:money(r.principal),fee:money(r.fee),providerReference:r.provider_reference,inSettlement:!!r.settlement_id,accountingStatus:r.accounting_status}))}
  }
  return {asOf:new Date().toISOString(),pendingNotices,toSettle:toSettle.toFixed(2),settlementReferences:references,depositsByRealDate:{date,...settlements},corrections,disputes}
}
const keyOf = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')

async function readFinal(db, scope, date) {
  const [row] = await db.$queryRaw`SELECT d.snapshot,d.content_hash,d.finalized_at,u.name AS finalized_by_name FROM cash_daily_consolidations d JOIN users u ON u.id=d.finalized_by_id
    WHERE d.company_id=${scope.companyId}::uuid AND d.branch_id=${scope.branchId}::uuid AND d.business_date=${date}::date`
  return row ? { snapshot:row.snapshot, status: 'FINALIZED', contentKey: row.content_hash, finalizedBy: row.finalized_by_name, finalizedAt: iso(row.finalized_at) } : null
}
async function dayView(db, scope, rawDate) {
  const date = day(rawDate)
  if (!await dailyAvailable(db)) fail(409, 'CASH_DAY_UNAVAILABLE', 'El cierre del día todavía no está disponible.')
  const final = await readFinal(db, scope, date)
  if (final) return {...final,current:await currentState(db,scope,date,final.snapshot)}
  const snapshot = await compute(db, scope, date)
  return { snapshot, current:await currentState(db,scope,date,snapshot), status: 'PROVISIONAL', contentKey: keyOf(snapshot), finalizedBy: null, finalizedAt: null }
}

// Finalizar guarda la vista revisada si sigue igual y nada bloquea. Un reintento con la misma clave devuelve el mismo documento.
async function finalizeDay(tx, scope, rawDate, input = {}) {
  const date = day(rawDate)
  if (!await dailyAvailable(tx)) fail(409, 'CASH_DAY_UNAVAILABLE', 'El cierre del día todavía no está disponible.')
  if (typeof input.contentKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentKey)) fail(428, 'CASH_DAY_KEY', 'Recarga el resumen del día antes de finalizarlo')
  await tx.$queryRaw`SELECT cash_day_lock(${scope.companyId}::uuid,${scope.branchId}::uuid,${date}::date)::text`
  const final = await readFinal(tx, scope, date)
  if (final) {
    if (final.contentKey === input.contentKey) return { replayed: true, view: {...final,current:await currentState(tx,scope,date,final.snapshot)} }
    fail(409, 'CASH_DAY_FINALIZED', 'Este día ya fue finalizado. Recarga el resumen.')
  }
  // Source writers also lock registers (float transfers) or sessions (counts/handovers).
  // NOWAIT avoids a register → day → session cycle with an opening and a handover.
  try {
    await tx.$queryRaw`SELECT r.id FROM cash_registers r JOIN branches b ON b.id=r.branch_id WHERE b.company_id=${scope.companyId}::uuid AND r.branch_id=${scope.branchId}::uuid AND r.money_event_version=1 ORDER BY r.id FOR UPDATE OF r NOWAIT`
    await tx.$queryRaw`SELECT s.id FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id WHERE r.branch_id=${scope.branchId}::uuid AND s.money_event_version=1 AND s.business_date=${date}::date ORDER BY s.id FOR UPDATE OF s NOWAIT`
    if(await has(tx,'cash_bank_event_modes'))await tx.$queryRaw`SELECT m.event_id FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id JOIN cash_register_sessions s ON s.id=e.cash_register_session_id
      WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid AND s.business_date=${date}::date ORDER BY m.event_id FOR SHARE OF m NOWAIT`
  }catch(error){
    if(error.meta?.code==='55P03'||error.code==='55P03')fail(409,'CASH_DAY_BUSY','Hay una operación de caja o liquidación en curso. Espera a que termine y recarga el resumen antes de finalizar; no se guardó el cierre del día.')
    throw error
  }
  const snapshot = await compute(tx, scope, date)
  if (snapshot.blockers.length) fail(409, 'CASH_DAY_BLOCKED', `No se puede finalizar: ${snapshot.blockers.map(b => b.message).join(' ')}`)
  const key = keyOf(snapshot)
  if (key !== input.contentKey) fail(409, 'CASH_DAY_CHANGED', 'El día cambió desde que lo revisaste (llegó un cobro o cambió un arqueo). Recarga el resumen antes de finalizar.')
  try {
    await tx.$executeRaw`INSERT INTO cash_daily_consolidations(company_id,branch_id,business_date,content_hash,snapshot,finalized_by_id)
      VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${date}::date,${key},${JSON.stringify(snapshot)}::jsonb,${scope.userId}::uuid)`
  } catch (e) {
    if (/cash_day_open_turn|cash_day_pending/.test(String(e?.message))) fail(409, 'CASH_DAY_BLOCKED', 'Un turno sigue operando o tiene su arqueo pendiente. Recarga el resumen.')
    throw e
  }
  return { replayed: false, view: await dayView(tx,scope,date) }
}

module.exports = { dailyAvailable, dayView, finalizeDay }
