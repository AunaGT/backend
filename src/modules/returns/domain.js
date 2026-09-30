const ACTIVE_RETURN_STATUSES = Object.freeze(['Pendiente', 'Aprobada', 'Completada'])

const RETURN_RESOLUTIONS = Object.freeze([
  'REFUND_ORIGINAL',
  'REFUND_CASH',
  'REFUND_TRANSFER',
  'CUSTOMER_CREDIT',
  'EXCHANGE',
])

const DEFAULT_RETURN_POLICY = Object.freeze({
  windowDays: 30,
  allowAuthorizedExceptions: true,
  exchangePricing: 'CURRENT_PRICE',
  enabledResolutions: RETURN_RESOLUTIONS,
})

const TRANSITIONS = Object.freeze({
  Pendiente: new Set(['Aprobada', 'Rechazada']),
  Aprobada: new Set(['Completada', 'Rechazada']),
})

function invalid(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function statusName(value) {
  return typeof value === 'string' ? value : value?.name
}

function availableReturnQty(originalQty, returned = []) {
  const reserved = returned.reduce((total, item) => (
    ACTIVE_RETURN_STATUSES.includes(statusName(item.status))
      ? total + Number(item.qty_returned || 0)
      : total
  ), 0)
  return Math.max(0, Number(originalQty || 0) - reserved)
}

function assertReturnTransition(from, to) {
  if (!TRANSITIONS[from]) throw new Error(`La devolución está en un estado terminal: ${from}`)
  if (!TRANSITIONS[from].has(to)) {
    if (to === 'Completada') throw new Error('La devolución debe aprobarse antes de completarse')
    throw new Error(`Transición de devolución no permitida: ${from} → ${to}`)
  }
  return { terminal: to === 'Completada' || to === 'Rechazada', processes: to === 'Completada' }
}

function normalizeReturnLines(items) {
  if (!Array.isArray(items) || items.length === 0) throw invalid('Debe incluir al menos una línea')
  const seen = new Set()
  return items.map((item) => {
    const saleItemId = Number(item?.sale_item_id)
    const qty = Number(item?.qty_returned)
    const productId = String(item?.product_id || '').trim()
    if (!Number.isInteger(saleItemId) || saleItemId <= 0 || !productId) {
      throw invalid('Cada línea requiere sale_item_id y product_id válidos')
    }
    if (!Number.isInteger(qty) || qty <= 0) throw invalid('La cantidad devuelta debe ser entera y mayor a cero')
    if (seen.has(saleItemId)) throw invalid(`Línea repetida: ${saleItemId}`)
    seen.add(saleItemId)
    return {
      sale_item_id: saleItemId,
      product_id: productId,
      qty_returned: qty,
      reason: String(item.reason || '').trim() || null,
    }
  })
}

function parseDate(value, end = false) {
  if (!value) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new Error('Fecha de devolución inválida')
  if (end) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

function buildReturnWhere(scope, filters = {}) {
  const search = String(filters.search || '').trim()
  const where = { sale: { ...scope } }
  if (filters.status) where.status = { name: String(filters.status) }
  if (filters.type) where.type = String(filters.type)
  if (filters.reason) where.reason = { contains: String(filters.reason).trim(), mode: 'insensitive' }
  const from = parseDate(filters.date_from)
  const to = parseDate(filters.date_to, true)
  if (from || to) where.return_date = { ...(from && { gte: from }), ...(to && { lt: to }) }
  if (search) {
    where.OR = [
      { sale: { reference: { contains: search, mode: 'insensitive' } } },
      { sale: { customer: { contains: search, mode: 'insensitive' } } },
      { sale: { customerContact: { is: { name: { contains: search, mode: 'insensitive' } } } } },
      { return_items: { some: { product: { name: { contains: search, mode: 'insensitive' } } } } },
      { replacement_items: { some: { product: { name: { contains: search, mode: 'insensitive' } } } } },
    ]
  }
  return where
}

function estimateRefundAmount({ saleTotal, grossTotal, unitPrice, qty }) {
  const gross = Number(grossTotal)
  if (!(gross > 0)) return 0
  return Math.round(Number(unitPrice) * Number(qty) * (Number(saleTotal) / gross) * 100) / 100
}

function normalizeReturnPolicy(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { value = null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_RETURN_POLICY
  const windowDays = Number(value.windowDays)
  const enabled = Array.isArray(value.enabledResolutions)
    ? [...new Set(value.enabledResolutions.filter((item) => RETURN_RESOLUTIONS.includes(item)))]
    : RETURN_RESOLUTIONS
  return {
    windowDays: Number.isInteger(windowDays) && windowDays >= 1 ? windowDays : DEFAULT_RETURN_POLICY.windowDays,
    allowAuthorizedExceptions: value.allowAuthorizedExceptions !== false,
    exchangePricing: value.exchangePricing === 'ORIGINAL_SALE_PRICE' ? 'ORIGINAL_SALE_PRICE' : 'CURRENT_PRICE',
    enabledResolutions: enabled.length ? enabled : RETURN_RESOLUTIONS,
  }
}

function evaluateReturnEligibility({ saleDate, statusName, availableUnits, policy, now = new Date(), override }) {
  const normalized = normalizeReturnPolicy(policy)
  const elapsedMs = new Date(now).getTime() - new Date(saleDate).getTime()
  const daysElapsed = Math.max(0, Math.floor(elapsedMs / 86400000))
  const reasons = []
  if (statusName !== 'Completada') reasons.push('SALE_NOT_COMPLETED')
  if (!(Number(availableUnits) > 0)) reasons.push('NO_RETURNABLE_UNITS')
  const expired = daysElapsed > normalized.windowDays
  const exceptionApplied = expired && normalized.allowAuthorizedExceptions && override?.authorized === true && String(override.reason || '').trim().length > 0
  if (expired && !exceptionApplied) reasons.push('RETURN_WINDOW_EXPIRED')
  return { eligible: reasons.length === 0, daysElapsed, reasons, exceptionApplied }
}

module.exports = {
  ACTIVE_RETURN_STATUSES,
  DEFAULT_RETURN_POLICY,
  RETURN_RESOLUTIONS,
  availableReturnQty,
  assertReturnTransition,
  buildReturnWhere,
  evaluateReturnEligibility,
  estimateRefundAmount,
  normalizeReturnPolicy,
  normalizeReturnLines,
}
