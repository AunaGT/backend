const { createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { exactMoney } = require('../receivables/paymentAttempts')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const D = value => new Prisma.Decimal(String(value ?? 0))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LINKS = { SALE: 'sales', DOCUMENT: 'commercial_documents', ENGAGEMENT: 'appointment_engagements' }

function id(value, label) { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'CASH_NOTICE_INPUT', `${label} no es válido`); return value }
function text(value, label, max, required = false) {
  if (value == null || value === '') { if (required) fail(400, 'CASH_NOTICE_INPUT', `Indica ${label}`); return null }
  if (typeof value !== 'string' || value.trim().length > max || required && !value.trim()) fail(400, 'CASH_NOTICE_INPUT', `${label}: hasta ${max} caracteres`)
  return value.trim() || null
}
// Fecha civil YYYY-MM-DD que ya ocurrió (no se aceptan pagos futuros).
function day(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) fail(400, 'CASH_NOTICE_INPUT', `${label} no es una fecha válida`)
  if (new Date(value + 'T00:00:00Z') > new Date(Date.now() + 864e5)) fail(400, 'CASH_NOTICE_INPUT', `${label} no puede ser futura`)
  return value
}

async function noticesAvailable(db) {
  return (await db.$queryRaw`SELECT to_regclass('cash_payment_notices') IS NOT NULL AS ok`)[0]?.ok === true
}
async function requireAvailable(db) { if (!await noticesAvailable(db)) fail(409, 'CASH_NOTICE_UNAVAILABLE', 'Los avisos de pago todavía no están disponibles.') }

const select = Prisma.sql`SELECT n.*,c.name AS customer_name,pm.name AS payment_method_name,u.name AS created_by_name,cu.name AS confirmed_by_name,ru.name AS rejected_by_name,
  r.name AS register_name FROM cash_payment_notices n JOIN suppliers c ON c.id=n.customer_id JOIN payment_methods pm ON pm.id=n.payment_method_id JOIN users u ON u.id=n.created_by_id
  LEFT JOIN users cu ON cu.id=n.confirmed_by_id LEFT JOIN users ru ON ru.id=n.rejected_by_id
  LEFT JOIN cash_register_sessions s ON s.id=n.cash_register_session_id LEFT JOIN cash_registers r ON r.id=s.cash_register_id`
const iso = v => v ? new Date(v).toISOString() : null
const civil = v => v ? new Date(v).toISOString().slice(0, 10) : null
const dto = n => n && ({ ...n, amount: D(n.amount).toFixed(2), reported_paid_on: civil(n.reported_paid_on), paid_on: civil(n.paid_on),
  created_at: iso(n.created_at), confirmed_at: iso(n.confirmed_at), rejected_at: iso(n.rejected_at), request_hash: undefined })
async function read(db, scope, noticeId, lock = false) {
  const [row] = await db.$queryRaw(Prisma.sql`${lock ? Prisma.sql`SELECT n.* FROM cash_payment_notices n` : select} WHERE n.id::text=${String(noticeId)} AND n.company_id=${scope.companyId}::uuid AND n.branch_id=${scope.branchId}::uuid${lock ? Prisma.sql` FOR UPDATE` : Prisma.empty}`)
  return row || null
}
async function getNotice(db, scope, noticeId) {
  await requireAvailable(db)
  const row = await read(db, scope, noticeId)
  if (!row) fail(404, 'CASH_NOTICE_NOT_FOUND', 'Aviso no encontrado')
  return dto(row)
}

async function createNotice(tx, scope, raw = {}) {
  await requireAvailable(tx)
  const input = { requestKey: id(raw.requestKey, 'La clave del intento'), customerId: id(raw.customerId, 'El cliente'), amount: exactMoney(raw.amount),
    paymentMethodId: Number(raw.paymentMethodId), reportedPaidOn: day(raw.reportedPaidOn, 'La fecha informada'),
    reportedReference: text(raw.reportedReference, 'La referencia informada', 120), notes: text(raw.notes, 'La nota', 1000),
    link: raw.link ? { kind: raw.link.kind, id: id(raw.link.id, 'El documento enlazado') } : null }
  if (!Number.isSafeInteger(input.paymentMethodId)) fail(400, 'CASH_NOTICE_INPUT', 'Selecciona el medio de pago')
  if (input.link && !LINKS[input.link.kind]) fail(400, 'CASH_NOTICE_INPUT', 'El documento enlazado no es válido')
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-notice', scope.companyId, scope.branchId, scope.userId, input.requestKey])},0))::text`
  const [old] = await tx.$queryRaw`SELECT id,request_hash FROM cash_payment_notices WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND created_by_id=${scope.userId}::uuid AND request_key=${input.requestKey}::uuid`
  if (old) { if (old.request_hash !== hash) fail(409, 'CASH_NOTICE_ATTEMPT_CONFLICT', 'Este intento corresponde a otro aviso; recupera su resultado antes de cambiarlo.'); return { replayed: true, notice: dto(await read(tx, scope, old.id)) } }
  const [customer] = await tx.$queryRaw`SELECT id FROM suppliers WHERE id=${input.customerId}::uuid AND company_id=${scope.companyId}::uuid AND party_type='CUSTOMER'`
  if (!customer) fail(404, 'CASH_NOTICE_CUSTOMER', 'Cliente no encontrado en la empresa')
  if (input.link) {
    const [linked] = await tx.$queryRaw(Prisma.sql`SELECT 1 FROM ${Prisma.raw(LINKS[input.link.kind])} WHERE id=${input.link.id}::uuid AND branch_id=${scope.branchId}::uuid`)
    if (!linked) fail(404, 'CASH_NOTICE_LINK', 'El documento enlazado no está en la sucursal activa')
  }
  const [row] = await guarded(() => tx.$queryRaw`INSERT INTO cash_payment_notices(company_id,branch_id,customer_id,amount,currency_code,payment_method_id,reported_paid_on,reported_reference,link_kind,link_id,notes,created_by_id,request_key,request_hash)
    VALUES(${scope.companyId}::uuid,${scope.branchId}::uuid,${input.customerId}::uuid,${input.amount}::numeric,(SELECT value FROM system_settings WHERE company_id=${scope.companyId}::uuid AND key='currency_code'),
    ${input.paymentMethodId},${input.reportedPaidOn}::date,${input.reportedReference},${input.link?.kind ?? null},${input.link?.id ?? null}::uuid,${input.notes},${scope.userId}::uuid,${input.requestKey}::uuid,${hash}) RETURNING id`)
  return { replayed: false, notice: dto(await read(tx, scope, row.id)) }
}

// Las guardas de la BD hablan en códigos; aquí se traducen a mensajes para quien opera.
async function guarded(work) {
  try { return await work() } catch (e) {
    const message = String(e?.message || '')
    if (/cash_notice_method/.test(message)) fail(409, 'CASH_NOTICE_METHOD', 'El aviso solo admite un medio digital habilitado de la empresa.')
    if (/cash_notice_scope/.test(message)) fail(409, 'CASH_NOTICE_SCOPE', 'El cliente o la moneda no corresponden a la empresa.')
    if (/cash_notice_payment/.test(message)) fail(409, 'CASH_NOTICE_PERIOD', 'El cobro debe quedar en un período abierto de caja virtual de esta sucursal.')
    if (/cash_notice_state/.test(message)) fail(409, 'CASH_NOTICE_STATE', 'El aviso ya fue confirmado o rechazado. Consulta su estado actual.')
    throw e
  }
}

// Confirmación manual: un solo cobro, en un período abierto de caja virtual de la misma sucursal, con evidencia y constancia.
async function confirmNotice(tx, scope, noticeId, raw = {}) {
  await requireAvailable(tx)
  const input = { sessionId: id(raw.sessionId, 'El período de caja virtual'), paidOn: day(raw.paidOn, 'La fecha real del pago'),
    externalReference: text(raw.externalReference, 'la referencia del banco o proveedor', 120, true),
    verificationId: text(raw.verificationId, 'El identificador verificable', 120), evidencePath: raw.evidencePath ?? null }
  if (input.evidencePath !== null && (typeof input.evidencePath !== 'string' || !input.evidencePath.startsWith(`${scope.companyId}/notices/`) || !/^[0-9a-f-]{36}\/notices\/[0-9a-f-]{36}\.(pdf|png|jpg)$/i.test(input.evidencePath)))
    fail(400, 'CASH_NOTICE_EVIDENCE', 'La evidencia no corresponde a esta empresa')
  if (!input.verificationId && !input.evidencePath) fail(400, 'CASH_NOTICE_EVIDENCE', 'Agrega el identificador verificable o un archivo de evidencia')
  if (raw.attested !== true) fail(400, 'CASH_NOTICE_ATTESTATION', 'Confirma que revisaste el depósito en el banco o proveedor')
  const notice = await read(tx, scope, noticeId, true)
  if (!notice) fail(404, 'CASH_NOTICE_NOT_FOUND', 'Aviso no encontrado')
  if (notice.status === 'CONFIRMED') {
    const same = notice.cash_register_session_id === input.sessionId && civil(notice.paid_on) === input.paidOn && notice.external_reference === input.externalReference
      && notice.verification_id === input.verificationId && notice.evidence_path === input.evidencePath && notice.confirmed_by_id === scope.userId
    if (!same) fail(409, 'CASH_NOTICE_STATE', 'El aviso ya fue confirmado con otros datos. Consulta su estado actual.')
    return { replayed: true, notice: dto(await read(tx, scope, noticeId)) }
  }
  if (notice.status !== 'PENDING') fail(409, 'CASH_NOTICE_STATE', 'El aviso ya fue rechazado. Consulta su estado actual.')
  const [period] = await tx.$queryRaw`SELECT s.id FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id
    WHERE s.id=${input.sessionId}::uuid AND r.branch_id=${scope.branchId}::uuid AND r.kind='VIRTUAL' AND s.register_type='VIRTUAL' AND s.status='OPEN' AND s.money_event_version=1 FOR UPDATE OF s`
  if (!period) fail(409, 'CASH_NOTICE_PERIOD', 'Selecciona un período abierto de caja virtual de esta sucursal. Los cobros digitales no se registran en cajas físicas ni en períodos cerrados.')
  const applications = Array.isArray(raw.applications) && raw.applications.length ? raw.applications.map(a => ({ sale_id: id(a?.saleId, 'La venta'), amount: Number(exactMoney(a?.amount)) })) : null
  const { paymentId } = await require('../receivables').applyPayment(tx, { companyId: scope.companyId, branchId: scope.branchId, userId: scope.userId, isAdmin: scope.isAdmin,
    customerId: notice.customer_id, amount: Number(notice.amount), paymentMethodId: notice.payment_method_id, cashRegisterSessionId: input.sessionId,
    reference: input.externalReference, notes: `Aviso de pago confirmado manualmente (${input.paidOn})`, manualApplications: applications, allowAdvance: raw.allowAdvance === true })
  await guarded(() => tx.$executeRaw`UPDATE cash_payment_notices SET status='CONFIRMED',customer_payment_id=${paymentId}::uuid,confirmed_by_id=${scope.userId}::uuid,paid_on=${input.paidOn}::date,
    external_reference=${input.externalReference},verification_id=${input.verificationId},evidence_path=${input.evidencePath},attested=true,cash_register_session_id=${input.sessionId}::uuid WHERE id=${notice.id}::uuid`)
  return { replayed: false, notice: dto(await read(tx, scope, notice.id)) }
}

async function rejectNotice(tx, scope, noticeId, raw = {}) {
  await requireAvailable(tx)
  const reason = text(raw.reason, 'el motivo del rechazo', 1000, true)
  const notice = await read(tx, scope, noticeId, true)
  if (!notice) fail(404, 'CASH_NOTICE_NOT_FOUND', 'Aviso no encontrado')
  if (notice.status === 'REJECTED' && notice.rejection_reason === reason && notice.rejected_by_id === scope.userId) return { replayed: true, notice: dto(await read(tx, scope, noticeId)) }
  if (notice.status !== 'PENDING') fail(409, 'CASH_NOTICE_STATE', 'El aviso ya fue confirmado o rechazado. Consulta su estado actual.')
  await guarded(() => tx.$executeRaw`UPDATE cash_payment_notices SET status='REJECTED',rejected_by_id=${scope.userId}::uuid,rejection_reason=${reason} WHERE id=${notice.id}::uuid`)
  return { replayed: false, notice: dto(await read(tx, scope, notice.id)) }
}

async function listNotices(db, scope, query = {}) {
  await requireAvailable(db)
  const page = Math.max(1, Number(query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))
  const status = ['PENDING', 'CONFIRMED', 'REJECTED'].includes(query.status) ? query.status : null
  const search = typeof query.search === 'string' && query.search.trim() ? `%${query.search.trim().slice(0, 80)}%` : null
  const where = Prisma.sql`WHERE n.company_id=${scope.companyId}::uuid AND n.branch_id=${scope.branchId}::uuid ${status ? Prisma.sql`AND n.status=${status}` : Prisma.empty}
    ${search ? Prisma.sql`AND (c.name ILIKE ${search} OR n.reported_reference ILIKE ${search} OR n.external_reference ILIKE ${search})` : Prisma.empty}`
  const rows = await db.$queryRaw(Prisma.sql`${select} ${where} ORDER BY n.status='PENDING' DESC,n.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)
  const [{ total }] = await db.$queryRaw(Prisma.sql`SELECT count(*)::int AS total FROM cash_payment_notices n JOIN suppliers c ON c.id=n.customer_id ${where}`)
  const [{ pending }] = await db.$queryRaw`SELECT count(*)::int AS pending FROM cash_payment_notices WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND status='PENDING'`
  return { items: rows.map(dto), totalItems: total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), summary: { pending } }
}

// Períodos donde se puede confirmar: abiertos, de caja virtual, de la sucursal y del actor (o cualquiera si es admin).
async function confirmPeriods(db, scope) {
  return db.$queryRaw`SELECT s.id,r.name AS register_name,s.opened_at,u.name AS responsible_name FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN users u ON u.id=s.opened_by_id
    WHERE r.branch_id=${scope.branchId}::uuid AND r.kind='VIRTUAL' AND s.status='OPEN' AND s.money_event_version=1 ${scope.isAdmin ? Prisma.empty : Prisma.sql`AND s.opened_by_id=${scope.userId}::uuid`} ORDER BY r.name`
}

module.exports = { noticesAvailable, createNotice, confirmNotice, rejectNotice, getNotice, listNotices, confirmPeriods }
