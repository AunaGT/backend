const ACTIVE_RETURN_STATUSES = Object.freeze(['Pendiente', 'Aprobada', 'Completada'])

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

module.exports = {
  ACTIVE_RETURN_STATUSES,
  availableReturnQty,
  assertReturnTransition,
  buildReturnWhere,
  estimateRefundAmount,
  normalizeReturnLines,
}
