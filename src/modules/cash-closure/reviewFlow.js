const { reviewAvailable, resolvePolicy, classify } = require('./policy')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }

function reason(value, required) {
  if (value == null || value === '') { if (required) fail(400, 'CASH_REVIEW_REASON', 'Indica el motivo'); return null }
  if (typeof value !== 'string' || value.trim().length > 1000 || required && !value.trim()) fail(400, 'CASH_REVIEW_REASON', 'Indica el motivo en hasta 1000 caracteres')
  return value.trim() || null
}

// Turno con libro (v1) y DDL presente: el arqueo entra al flujo con política. Un turno en reconteo admite un arqueo sustituto.
async function lockDeclaredSession(tx, sessionId) {
  const [row] = await tx.$queryRaw`SELECT s.money_event_version,s.cash_closure_id::text AS closure_id,(to_jsonb(c)->>'status') AS closure_status
    FROM cash_register_sessions s LEFT JOIN cash_closures c ON c.id=s.cash_closure_id WHERE s.id=${sessionId}::uuid FOR UPDATE OF s`
  return row || null
}

async function adoptDeclaration(tx, { session, closureId, sessionId, data, declaration, companyId, branchId }) {
  const recount = session?.closure_id && session.closure_status === 'Reconteo'
  const v1 = session?.money_event_version === 1 && await reviewAvailable(tx)
  if (v1) {
    const policy = await resolvePolicy(tx, companyId, branchId), classification = classify(declaration.payments, data.payment_breakdown, policy)
    const snapshot = { source: policy.source, revision: policy.revision, cash_threshold: policy.cash_threshold, digital_threshold: policy.digital_threshold, blind_count: policy.blind_count }
    await tx.$executeRaw`UPDATE cash_closures SET review_flow_version=1,supersedes_closure_id=${recount ? session.closure_id : null}::uuid,policy_snapshot=${JSON.stringify(snapshot)}::jsonb,
      review_result=${classification.result},review_classification=${JSON.stringify({ lines: classification.lines })}::jsonb WHERE id=${closureId}::uuid`
  }
  if (recount && v1) {
    await tx.$executeRaw`UPDATE cash_register_sessions SET cash_closure_id=${closureId}::uuid WHERE id=${sessionId}::uuid AND cash_closure_id=${session.closure_id}::uuid`
    await tx.$executeRaw`UPDATE cash_closures SET status='Sustituido',updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond') WHERE id=${session.closure_id}::uuid`
    return true
  }
  const linked = await tx.cashRegisterSession.updateMany({ where: { id: sessionId, status: 'CLOSED', cash_closure_id: null }, data: { cash_closure_id: closureId } })
  if (linked.count !== 1) fail(409, 'CASH_CLOSURE_LINKED', 'Este turno ya tiene un arqueo registrado. Actualiza la lista.')
  return v1
}

// Los endpoints anteriores (aprobar/rechazar/firmar) no operan arqueos del flujo nuevo.
async function assertLegacyReview(tx, closureId) {
  const [row] = await tx.$queryRaw`SELECT (to_jsonb(c)->>'review_flow_version')::int AS v FROM cash_closures c WHERE c.id::text=${String(closureId)}`
  if (row?.v === 1) fail(409, 'CASH_REVIEW_FLOW', 'Este arqueo se revisa con la política de diferencias: usa Finalizar o Pedir reconteo.')
}

async function lockedClosure(tx, scope, id, expectedUpdatedAt) {
  if (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(+new Date(expectedUpdatedAt))) fail(428, 'CASH_REVIEW_VERSION', 'Recarga el arqueo antes de revisarlo')
  if (!await reviewAvailable(tx)) fail(409, 'CASH_REVIEW_UNAVAILABLE', 'La revisión con política todavía no está disponible.')
  const [c] = await tx.$queryRaw`SELECT c.id,c.status,c.review_flow_version,c.review_result,c.cashier_id,c.updated_at,s.id AS session_id,s.opened_by_id AS responsible_id
    FROM cash_closures c JOIN branches b ON b.id=c.branch_id LEFT JOIN cash_register_sessions s ON s.cash_closure_id=c.id
    WHERE c.id::text=${String(id)} AND c.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid FOR UPDATE OF c`
  if (!c) fail(404, 'CASH_REVIEW_NOT_FOUND', 'Arqueo no encontrado')
  if (c.review_flow_version !== 1) fail(409, 'CASH_REVIEW_LEGACY', 'Este arqueo usa la aprobación anterior.')
  if (c.status !== 'Pendiente') fail(409, 'CASH_REVIEW_STATE', 'Este arqueo ya fue revisado o está en reconteo. Recarga la información.')
  if (+new Date(c.updated_at) !== +new Date(expectedUpdatedAt)) fail(409, 'CASH_REVIEW_CHANGED', 'El arqueo cambió desde que lo abriste. Recarga antes de revisarlo.')
  // Quien declaró o el responsable del turno solo se revisa con la excepción del dueño, y queda marcado.
  let self = [c.cashier_id, c.responsible_id].includes(scope.userId) || !!c.session_id && await require('../../services/cashSharedSessions').participated(tx, c.session_id, scope.userId)
  if (self) {
    const [policy] = await tx.$queryRaw`SELECT owner_self_review FROM cash_difference_policies WHERE company_id=${scope.companyId}::uuid AND branch_id IS NULL`
    if (!policy?.owner_self_review) fail(403, 'CASH_REVIEW_SELF', 'Otra persona autorizada debe revisar tu propio arqueo.')
  }
  return { ...c, self }
}

async function record(tx, scope, c, action, text) {
  await tx.$executeRaw`INSERT INTO cash_closure_reviews(cash_closure_id,action,reason,actor_id,self_review) VALUES(${c.id}::uuid,${action},${text},${scope.userId}::uuid,${c.self})`
}
async function moveTo(tx, scope, c, status) {
  await tx.$executeRaw`UPDATE cash_closures SET status=${status},supervisor_id=${scope.userId}::uuid,supervisor_name=${(scope.userName || 'Encargado').slice(0, 100)},
    supervisor_validated_at=clock_timestamp(),updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond') WHERE id=${c.id}::uuid`
  return readReview(tx, c.id)
}

async function requestRecount(tx, scope, id, input = {}) {
  const c = await lockedClosure(tx, scope, id, input.expectedUpdatedAt)
  await record(tx, scope, c, 'RECOUNT_REQUESTED', reason(input.reason, true))
  return moveTo(tx, scope, c, 'Reconteo')
}

// Aceptar y finalizar son una sola acción; con diferencias fuera de tolerancia el motivo es obligatorio.
async function finalize(tx, scope, id, input = {}) {
  const c = await lockedClosure(tx, scope, id, input.expectedUpdatedAt), text = reason(input.reason, c.review_result === 'REVIEW')
  if (c.review_result === 'REVIEW') await record(tx, scope, c, 'DIFFERENCES_ACCEPTED', text)
  await record(tx, scope, c, 'FINALIZED', text)
  return moveTo(tx, scope, c, 'Aprobado')
}

async function readReview(db, id) {
  const [c] = await db.$queryRaw`SELECT c.id,c.status,c.review_flow_version,c.review_result,c.review_classification,c.policy_snapshot,c.supersedes_closure_id,c.updated_at,
    (SELECT n.id FROM cash_closures n WHERE n.supersedes_closure_id=c.id) AS superseded_by_id FROM cash_closures c WHERE c.id=${id}::uuid`
  c.reviews = await db.$queryRaw`SELECT r.action,r.reason,r.self_review,r.created_at,r.actor_id,u.name AS actor_name FROM cash_closure_reviews r JOIN users u ON u.id=r.actor_id
    WHERE r.cash_closure_id=${id}::uuid ORDER BY r.created_at,r.action`
  return c
}

module.exports = { lockDeclaredSession, adoptDeclaration, assertLegacyReview, requestRecount, finalize, readReview }

// Conteo ciego: quien declara su turno recibe solo los medios a contar, sin importes esperados.
async function isBlind(db, req, data) {
  if (!req.query?.cashier_id && !req.body?.cashierId || data.calculation_basis !== 'EVENTS_V1' || !await reviewAvailable(db)) return false
  return (await resolvePolicy(db, req.companyId, req.branchId)).blind_count === true
}
function blindView(data) {
  return { blind: true, period: data.period, calculation_basis: data.calculation_basis, calculation_basis_label: data.calculation_basis_label, currency_code: data.currency_code,
    business_timezone: data.business_timezone, calculation_key: data.calculation_key, cash_session: data.cash_session ? { id: data.cash_session.id } : null,
    payment_breakdown: data.payment_breakdown.map(m => ({ breakdown_key: m.breakdown_key, payment_method_id: m.payment_method_id, payment_method_name: m.payment_method_name, settlement_kind: m.settlement_kind })) }
}

async function reviewerException(db, scope) {
  const [p] = await db.$queryRaw`SELECT owner_self_review FROM cash_difference_policies WHERE company_id=${scope.companyId}::uuid AND branch_id IS NULL`
  return p?.owner_self_review === true
}

// Contexto de revisión: el revisor ve todo; quien declaró ve el suyo sin acciones; nadie más lo encuentra.
async function reviewContext(db, scope, id) {
  await require('./readQueries').assertReadable(db, { ...scope, branchIds: scope.branchIds || [scope.branchId], viewOwn: scope.viewOwn || scope.canReview, viewTeam: scope.viewTeam || scope.canReview, mode: scope.viewTeam || scope.canReview ? 'team' : 'mine' }, id)
  if (!await reviewAvailable(db)) fail(404, 'CASH_REVIEW_NOT_FOUND', 'Arqueo no encontrado')
  const [c] = await db.$queryRaw`SELECT c.id,c.cashier_id,s.id AS session_id,s.opened_by_id AS responsible_id FROM cash_closures c JOIN branches b ON b.id=c.branch_id LEFT JOIN cash_register_sessions s ON s.cash_closure_id=c.id
    WHERE c.id::text=${String(id)} AND c.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND c.review_flow_version=1`
  const self = !!c && ([c.cashier_id, c.responsible_id].includes(scope.userId) || !!c.session_id && await require('../../services/cashSharedSessions').participated(db, c.session_id, scope.userId))
  if (!c) fail(404, 'CASH_REVIEW_NOT_FOUND', 'Arqueo no encontrado')
  const review = await readReview(db, c.id)
  const history = await db.$queryRaw`WITH RECURSIVE chain AS (SELECT id,supersedes_closure_id FROM cash_closures WHERE id=${c.id}::uuid AND branch_id=${scope.branchId}::uuid
      UNION SELECT p.id,p.supersedes_closure_id FROM cash_closures p JOIN chain ON p.id=chain.supersedes_closure_id WHERE p.branch_id=${scope.branchId}::uuid)
    SELECT x.id,x.closure_number,x.actual_total::text AS actual_total,x.difference::text AS difference,x.review_result,x.review_classification,x.created_at,
      (SELECT jsonb_agg(jsonb_build_object('action',r.action,'reason',r.reason,'actor_name',u.name,'created_at',r.created_at) ORDER BY r.created_at) FROM cash_closure_reviews r JOIN users u ON u.id=r.actor_id WHERE r.cash_closure_id=x.id) AS reviews
    FROM chain JOIN cash_closures x ON x.id=chain.id WHERE x.id<>${c.id}::uuid ORDER BY x.created_at DESC,x.id DESC`
  const open = review.status === 'Pendiente' && scope.canReview && (!self || await reviewerException(db, scope))
  return { ...review, history, self, can: { finalize: open, recount: open } }
}

const STATES = { Pendiente: 'PENDING_REVIEW', Reconteo: 'RECOUNT', Aprobado: 'FINALIZED', Rechazado: 'REJECTED', Validado: 'PENDING_REVIEW' }
async function sessionState(db, scope, sessionId) {
  if (!await require('./readQueries').canReadSession(db, { ...scope, branchIds: scope.branchIds || [scope.branchId], viewTeam: scope.viewTeam || scope.canReview }, sessionId)) fail(404, 'CASH_SESSION_NOT_FOUND', 'Turno no encontrado')
  const [s] = await db.$queryRaw`SELECT s.id,s.status,s.opened_by_id,c.id AS closure_id,c.status AS closure_status FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
    JOIN branches b ON b.id=r.branch_id LEFT JOIN cash_closures c ON c.id=s.cash_closure_id
    WHERE s.id::text=${String(sessionId)} AND r.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid`
  if (!s) fail(404, 'CASH_SESSION_NOT_FOUND', 'Turno no encontrado')
  const state = s.status === 'OPEN' ? 'OPERATING' : !s.closure_id ? 'PENDING_COUNT' : STATES[s.closure_status] || 'PENDING_REVIEW'
  return { sessionId: s.id, state, closureId: s.closure_id, closureStatus: s.closure_status }
}

module.exports = { ...module.exports, isBlind, blindView, reviewContext, sessionState }
