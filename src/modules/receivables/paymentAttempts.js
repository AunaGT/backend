const { createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
function exactMoney(value, { allowZero = false } = {}) {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(value))) fail(400, 'INVALID_PAYMENT_AMOUNT', 'Indica un importe con hasta dos decimales')
  const amount = new Prisma.Decimal(String(value))
  if (amount.lt(0) || (!allowZero && amount.isZero()) || amount.gt('9999999999.99')) fail(400, 'INVALID_PAYMENT_AMOUNT', 'Importe fuera de rango')
  return amount.toFixed(2)
}
function paymentHash(body) {
  // Las ventas conservan su forma anterior en el hash; un cargo agrega tipo e identificador.
  const applications = body.applications?.length ? body.applications.map(a => a?.documentType === 'DISPUTE_CHARGE'
    ? { documentType: 'DISPUTE_CHARGE', documentId: String(a.documentId), amount: exactMoney(a.amount) }
    : { sale_id: String(a.sale_id ?? a.documentId), amount: exactMoney(a.amount) }).sort((a, b) => (a.sale_id ?? 'C:' + a.documentId).localeCompare(b.sale_id ?? 'C:' + b.documentId)) : null
  const value = { customer: body.customer_id, amount: exactMoney(body.amount), method: Number(body.payment_method_id), session: body.cash_register_session_id || null,
    applications, reference: String(body.reference || '').trim().slice(0, 255) || null, notes: String(body.notes || '').trim() || null,
    allowAdvance: body.allow_advance === true, paidAt: body.paid_at ? new Date(body.paid_at).toISOString() : 'SERVER_NOW' }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
async function beginPaymentAttempt(tx, scope, body) {
  const key = body.request_key
  if (key == null || key === '') return null
  if (typeof key !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(key)) fail(400, 'PAYMENT_KEY_INVALID', 'Actualiza la pantalla para obtener una clave de cobro válida')
  const hash = paymentHash(body)
  if (!await require('../cash-closure/eventStorage').ledgerAvailable(tx)) fail(409, 'PAYMENT_ATTEMPTS_UNAVAILABLE', 'Los cobros con recuperación segura aún no están habilitados. Actualiza el sistema antes de registrar este intento.')
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`receipt:${scope.companyId}:${scope.branchId}:${scope.userId}:${key.toLowerCase()}`},0))::text`
  const rows = await tx.$queryRaw`SELECT p.id,p.request_hash FROM customer_payments p JOIN branches b ON b.id=p.branch_id
    WHERE p.branch_id=${scope.branchId}::uuid AND b.company_id=${scope.companyId}::uuid AND p.registered_by=${scope.userId}::uuid AND p.request_key=${key}::uuid`
  if (rows[0] && rows[0].request_hash !== hash) fail(409, 'PAYMENT_ATTEMPT_CONFLICT', 'Este intento corresponde a otro cobro. Recupera su resultado antes de cambiarlo.')
  return { key, hash, paymentId: rows[0]?.id || null }
}
async function savePaymentAttempt(tx, paymentId, attempt) {
  if (attempt) await tx.$executeRaw`UPDATE customer_payments SET request_key=${attempt.key}::uuid,request_hash=${attempt.hash} WHERE id=${paymentId}::uuid`
}
module.exports = { paymentHash, beginPaymentAttempt, savePaymentAttempt, exactMoney }
