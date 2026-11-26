const { createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const storage = require('./eventStorage')
const { assertSessionOperation } = require('../../services/cashSessionBoundary')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const conflict = () => fail(409, 'CASH_EVENT_CONFLICT', 'Este movimiento ya está registrado con otro contenido. Revisa su origen antes de continuar.')

async function recordMoneyEvent(tx, scope, { session, sourceType, sourceId }) {
  if (!session || Number(session.money_event_version || 0) === 0) return null
  if (session.money_event_version !== 1) fail(409, 'CASH_EVENT_VERSION', 'La versión del turno no está disponible')
  if (!storage.sourceColumns[sourceType] || !uuid.test(sourceId || '')) fail(400, 'CASH_EVENT_SOURCE', 'Origen de dinero inválido')
  const source = await storage.loadSource(tx, sourceType, sourceId)
  if (!source || source.valid_scope === false || !scope?.companyId || !scope.branchId || !scope.userId || source.company_id !== scope.companyId || source.branch_id !== scope.branchId ||
      source.actor_id !== scope.userId || source.session_id !== session.id || session.company_id !== scope.companyId || session.branch_id !== scope.branchId) {
    fail(404, 'CASH_EVENT_NOT_FOUND', 'Movimiento no disponible en el alcance activo')
  }
  const rawAmount = String(source.amount)
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(rawAmount) || new Prisma.Decimal(rawAmount).gt('9999999999.99')) fail(400, 'CASH_EVENT_AMOUNT', 'Importe de dinero inválido')
  const amount = new Prisma.Decimal(rawAmount).toFixed(2), existing = await storage.findEvent(tx, sourceType, sourceId)
  if (!existing && (!source.eligible || amount === '0.00')) return null
  if (source.valid_money === false) fail(409, 'CASH_EVENT_NET', 'El importe recibido menos el cambio debe coincidir con el cobro real')
  const economicAt = new Date(source.economic_at)
  if (!Number.isFinite(economicAt.getTime())) fail(400, 'CASH_EVENT_DATE', 'Fecha económica inválida')
  let method, currency
  if (existing) {
    method = { id: existing.payment_method_id, name: existing.payment_method_name, settlement_kind: existing.settlement_kind }
    currency = existing.currency_code
  } else {
    method = await require('../../services/paymentMethods/access').resolvePaymentMethod(tx, { companyId: scope.companyId, methodId: source.method_id,
      purpose: source.direction === 'IN' ? 'RECEIPT' : sourceType === 'SUPPLIER_PAYMENT' ? 'SUPPLIER_PAYMENT' : 'REFUND' })
    if (!['CASH', 'BANK'].includes(method.settlement_kind)) fail(409, 'CASH_EVENT_METHOD_REVIEW', 'Clasifica este medio como efectivo o digital antes de usar el registro de movimientos')
    currency = (await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: scope.companyId, key: 'currency_code' } } }))?.value
    if (currency !== session.currency_code || source.currency_code && source.currency_code !== currency) fail(409, 'CASH_EVENT_CURRENCY', 'La moneda de la operación, empresa y turno debe coincidir')
    assertSessionOperation(session, scope, { settlementKind: method.settlement_kind, allowOtherUser: sourceType === 'PHYSICAL_MOVEMENT' && scope.canCreateTeam === true || sourceType === 'CUSTODY_ENTRY' && scope.canOperateTeam === true })
  }
  const event = { company_id: scope.companyId, branch_id: scope.branchId, cash_register_id: session.cash_register_id,
    cash_register_session_id: session.id, source_type: sourceType, source_id: sourceId, direction: source.direction, amount,
    payment_method_id: source.method_id, payment_method_name: method.name, settlement_kind: method.settlement_kind,
    currency_code: session.currency_code, actor_id: source.actor_id, economic_at: economicAt.toISOString(), reference: existing ? existing.reference : source.reference || null }
  if (currency !== event.currency_code || source.currency_code && source.currency_code !== event.currency_code || !['IN', 'OUT'].includes(event.direction)) conflict()
  event.content_hash = createHash('sha256').update(JSON.stringify(event)).digest('hex')
  if (existing) { if (existing.content_hash !== event.content_hash) conflict(); return { id: existing.id, replayed: true } }
  const inserted = await storage.insertEvent(tx, event)
  if (inserted) return { id: inserted.id, replayed: false }
  const raced = await storage.findEvent(tx, sourceType, sourceId)
  if (raced?.content_hash !== event.content_hash) conflict()
  return { id: raced.id, replayed: true }
}
module.exports = { recordMoneyEvent }
