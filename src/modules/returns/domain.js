const ACTIVE_RETURN_STATUSES = Object.freeze(['Pendiente', 'Aprobada', 'Completada'])
const {Prisma}=require('@prisma/client')
const {commercialQuantity}=require('../../services/catalogItemRules')

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
    !item.status || ACTIVE_RETURN_STATUSES.includes(statusName(item.status))
      ? total.add(String(item.qty_returned || 0))
      : total
  ), new Prisma.Decimal(0))
  return Prisma.Decimal.max(0,new Prisma.Decimal(String(originalQty || 0)).sub(reserved))
}

function assertReturnTransition(from, to) {
  if (!TRANSITIONS[from]) throw new Error(`La devolución está en un estado terminal: ${from}`)
  if (!TRANSITIONS[from].has(to)) {
    if (to === 'Completada') throw new Error('La devolución debe aprobarse antes de completarse')
    throw new Error(`Transición de devolución no permitida: ${from} → ${to}`)
  }
  return { terminal: to === 'Completada' || to === 'Rechazada', processes: to === 'Completada' }
}

function normalizeReturnLines(items,originalItems) {
  if (!Array.isArray(items) || items.length === 0) throw invalid('Debe incluir al menos una línea')
  const seen = new Set()
  return items.map((item) => {
    const saleItemId = Number(item?.sale_item_id)
    const productId = String(item?.product_id || '').trim()
    if (!Number.isInteger(saleItemId) || saleItemId <= 0 || !productId) {
      throw invalid('Cada línea requiere sale_item_id y product_id válidos')
    }
    const original=originalItems?.find(line=>Number(line.id)===saleItemId && line.product_id===productId)
    if (originalItems && !original) throw invalid('Partida no encontrada en la venta')
    const qty=commercialQuantity(item?.qty_returned,original || {kind:'STANDARD'})
    if (original?.item_kind==='SERVICE') for(const field of ['received_qty','restock_qty','disposition','stock_location_id']) if(item[field]!=null) throw invalid('El servicio no admite recepción ni reposición física')
    if (seen.has(saleItemId)) throw invalid(`Línea repetida: ${saleItemId}`)
    seen.add(saleItemId)
    return {
      sale_item_id: saleItemId,
      product_id: productId,
      qty_returned: qty.toString(),
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
  const gross = new Prisma.Decimal(String(grossTotal))
  if (gross.lte(0)) return 0
  return new Prisma.Decimal(String(unitPrice)).mul(String(qty)).mul(String(saleTotal)).div(gross).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toNumber()
}

function refundFromLine({originalQty,lineNet,qty,returnedQty=0,returnedAmount=0}) {
  const original=new Prisma.Decimal(String(originalQty))
  const requested=new Prisma.Decimal(String(qty))
  const available=original.sub(String(returnedQty))
  if (requested.lte(0) || requested.gt(available)) throw invalid('Cantidad supera el saldo disponible para devolver')
  const moneyLeft=Prisma.Decimal.max(0,new Prisma.Decimal(String(lineNet)).sub(String(returnedAmount)))
  return (requested.eq(available) ? moneyLeft : Prisma.Decimal.min(moneyLeft,new Prisma.Decimal(String(lineNet)).mul(requested).div(original).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP))).toNumber()
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

function returnFiscalStatus(saleDtes) {
  const originalDocuments = (saleDtes || [])
    .filter((dte) => dte.authorization || /autoriz/i.test(String(dte.status || '')))
    .map((dte) => ({
      id: dte.id,
      authorization: dte.authorization || null,
      series: dte.series || null,
      number: dte.number || null,
    }))
  return {
    requires_credit_note: originalDocuments.length > 0,
    status: originalDocuments.length ? 'PENDING_EXTERNAL_CREDIT_NOTE' : 'NOT_APPLICABLE',
    original_documents: originalDocuments,
  }
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
  refundFromLine,
  normalizeReturnPolicy,
  normalizeReturnLines,
  returnFiscalStatus,
}
