const { Prisma } = require('@prisma/client')
const { isCashMethod } = require('../../services/paymentMethods/behavior')
const D = value => new Prisma.Decimal(String(value ?? 0))
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const DEFAULT = { source: 'DEFAULT', cash_threshold: '0.00', digital_threshold: '0.00', blind_count: false, owner_self_review: false, revision: 0 }
const RANK = { CLEAN: 0, WITHIN: 1, REVIEW: 2 }

// Sin el DDL de 3C todo sigue con el flujo anterior.
async function reviewAvailable(db) {
  return (await db.$queryRaw`SELECT to_regclass('cash_closure_reviews') IS NOT NULL AS ok`)[0]?.ok === true
}

// La sucursal sustituye a la empresa; la excepción del dueño siempre viene de la empresa.
async function resolvePolicy(db, companyId, branchId) {
  const rows = await db.$queryRaw`SELECT branch_id,cash_threshold::numeric(12,2)::text AS cash_threshold,digital_threshold::numeric(12,2)::text AS digital_threshold,blind_count,owner_self_review,revision
    FROM cash_difference_policies WHERE company_id=${companyId}::uuid AND (branch_id IS NULL OR branch_id=${branchId}::uuid)`
  const company = rows.find(r => !r.branch_id), branch = rows.find(r => r.branch_id), row = branch || company
  if (!row) return { ...DEFAULT }
  return { source: branch ? 'BRANCH' : 'COMPANY', cash_threshold: row.cash_threshold, digital_threshold: row.digital_threshold,
    blind_count: row.blind_count, owner_self_review: !!company?.owner_self_review, revision: row.revision }
}

// Cada medio contra su propio umbral: un sobrante nunca compensa el faltante de otro medio.
function classify(payments, methods, policy) {
  const byKey = new Map(methods.map(m => [m.breakdown_key || m.payment_method_id, m]))
  const lines = payments.map(p => {
    const m = byKey.get(p.breakdown_key || p.payment_method_id)
    const kind = isCashMethod({ ...m, name: m.payment_method_name }, name => /efectivo|cash/i.test(name)) ? 'CASH' : 'DIGITAL'
    const difference = D(p.actual_amount).sub(D(m.theoretical_amount))
    const status = difference.isZero() ? 'CLEAN' : difference.abs().lte(D(kind === 'CASH' ? policy.cash_threshold : policy.digital_threshold)) ? 'WITHIN' : 'REVIEW'
    return { payment_method_id: m.payment_method_id, name: m.payment_method_name, kind, expected: D(m.theoretical_amount).toFixed(2), actual: D(p.actual_amount).toFixed(2), difference: difference.toFixed(2), status }
  })
  return { result: lines.reduce((worst, l) => RANK[l.status] > RANK[worst] ? l.status : worst, 'CLEAN'), lines }
}

function threshold(value, label) {
  if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(String(value))) fail(400, 'CASH_POLICY_AMOUNT', `${label}: ingresa un monto no negativo con hasta dos decimales`)
  return D(value).toFixed(2)
}

// Guarda la política de empresa (branchId null) o de sucursal con revisión esperada.
async function savePolicy(tx, scope, input) {
  const branchId = input.branchId ?? null
  if (branchId !== null && branchId !== scope.branchId) fail(403, 'CASH_POLICY_SCOPE', 'Solo puedes configurar la sucursal activa')
  const cash = threshold(input.cashThreshold, 'Umbral de efectivo'), digital = threshold(input.digitalThreshold, 'Umbral digital')
  if (typeof input.blindCount !== 'boolean') fail(400, 'CASH_POLICY_INPUT', 'Indica si el conteo es ciego')
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail(428, 'CASH_POLICY_REVISION', 'Recarga la política antes de guardarla')
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-policy:' + scope.companyId}, 0))`
  const [current] = await tx.$queryRaw`SELECT id,revision,owner_self_review FROM cash_difference_policies WHERE company_id=${scope.companyId}::uuid AND branch_id IS NOT DISTINCT FROM ${branchId}::uuid`
  if ((current?.revision ?? 0) !== input.expectedRevision) fail(409, 'CASH_POLICY_CHANGED', 'Otra persona cambió la política. Recarga antes de guardar.')
  let owner = current?.owner_self_review ?? false
  if (input.ownerSelfReview !== undefined && input.ownerSelfReview !== owner) {
    if (branchId !== null) fail(400, 'CASH_POLICY_OWNER_SCOPE', 'La excepción del dueño se configura para toda la empresa')
    if (!scope.isAdmin) fail(403, 'CASH_POLICY_OWNER_ADMIN', 'Solo el administrador puede cambiar la excepción del dueño')
    if (typeof input.ownerSelfReview !== 'boolean') fail(400, 'CASH_POLICY_INPUT', 'Indica si aplica la excepción del dueño')
    owner = input.ownerSelfReview
  }
  if (current) await tx.$executeRaw`UPDATE cash_difference_policies SET cash_threshold=${cash}::numeric,digital_threshold=${digital}::numeric,blind_count=${input.blindCount},
    owner_self_review=${owner},revision=revision+1,updated_by_id=${scope.userId}::uuid,updated_at=clock_timestamp() WHERE id=${current.id}::uuid`
  else await tx.$executeRaw`INSERT INTO cash_difference_policies(company_id,branch_id,cash_threshold,digital_threshold,blind_count,owner_self_review,updated_by_id)
    VALUES(${scope.companyId}::uuid,${branchId}::uuid,${cash}::numeric,${digital}::numeric,${input.blindCount},${owner},${scope.userId}::uuid)`
  return readPolicies(tx, scope)
}

async function readPolicies(db, scope) {
  const rows = await db.$queryRaw`SELECT p.branch_id,p.cash_threshold::numeric(12,2)::text AS cash_threshold,p.digital_threshold::numeric(12,2)::text AS digital_threshold,p.blind_count,p.owner_self_review,p.revision,p.updated_at,u.name AS updated_by_name
    FROM cash_difference_policies p JOIN users u ON u.id=p.updated_by_id WHERE p.company_id=${scope.companyId}::uuid AND (p.branch_id IS NULL OR p.branch_id=${scope.branchId}::uuid)`
  return { company: rows.find(r => !r.branch_id) || null, branch: rows.find(r => r.branch_id) || null, effective: await resolvePolicy(db, scope.companyId, scope.branchId) }
}

module.exports = { reviewAvailable, resolvePolicy, classify, savePolicy, readPolicies, DEFAULT }
