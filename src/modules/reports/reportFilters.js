const { DateTime } = require('luxon')

function reportError(status, message, code = 'INVALID_REPORT_FILTER') {
  return Object.assign(new Error(message), { status, statusCode: status, code })
}
function resolveReportPeriod(query = {}, timezone = 'America/Guatemala', nowIso = new Date().toISOString()) {
  const now = DateTime.fromISO(nowIso, { zone: timezone })
  if (!now.isValid) throw reportError(400, 'Zona horaria o fecha inválida')
  const integer = (key, fallback, min, max) => {
    const raw = query[key]
    if (raw === undefined || raw === '') return fallback
    if (!['string', 'number'].includes(typeof raw) || !/^\d+$/.test(String(raw))) throw reportError(400, `Filtro ${key} inválido`)
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw reportError(400, `Filtro ${key} inválido`)
    return value
  }
  const year = integer('year', now.year, 1900, 9998)
  const month = integer('month', now.month, 1, 12)
  const quarter = integer('quarter', now.quarter, 1, 4)
  const semester = integer('semester', now.month <= 6 ? 1 : 2, 1, 2)
  const period = query.period || 'month'
  if (period === 'all') return { mode: 'period', start: null, endExclusive: null, label: 'Todo el historial' }
  if (period === 'current') return { mode: 'current', start: null, endExclusive: null, label: 'Estado actual' }
  let start, end
  if (period === 'week') { start = now.startOf('week'); end = start.plus({ weeks: 1 }) }
  else if (period === 'month') { start = DateTime.fromObject({ year, month, day: 1 }, { zone: timezone }); end = start.plus({ months: 1 }) }
  else if (period === 'quarter') { start = DateTime.fromObject({ year, month: (quarter - 1) * 3 + 1, day: 1 }, { zone: timezone }); end = start.plus({ months: 3 }) }
  else if (period === 'semester') { start = DateTime.fromObject({ year, month: (semester - 1) * 6 + 1, day: 1 }, { zone: timezone }); end = start.plus({ months: 6 }) }
  else if (period === 'year') { start = DateTime.fromObject({ year, month: 1, day: 1 }, { zone: timezone }); end = start.plus({ years: 1 }) }
  else throw reportError(400, 'Período de reporte inválido')
  return { mode: 'period', start: start.toUTC().toISO(), endExclusive: end.toUTC().toISO(),
    label: `${start.toFormat('dd/LL/yyyy')} – ${end.minus({ days: 1 }).toFormat('dd/LL/yyyy')}` }
}
function reportDateWhere(req, legacyStart, legacyEnd) {
  const p = req.reportPeriod
  if (!p) return { gte: legacyStart, lte: legacyEnd }
  return { ...(p.start ? { gte: new Date(p.start) } : {}), ...(p.endExclusive ? { lt: new Date(p.endExclusive) } : {}) }
}
async function validateReportScope(prisma, req) {
  const ids = req.branchId ? [req.branchId] : req.branchIds || []
  const query = req.query || {}
  for (const key of ['warehouse_id', 'location_id', 'product_id']) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query[key]))) {
      throw reportError(400, `Filtro ${key} inválido`)
    }
  }
  const scope = { branch_id: { in: ids }, branch: { company_id: req.companyId } }
  let warehouse = null, location = null
  if (query.warehouse_id) {
    warehouse = await prisma.warehouse.findFirst({ where: { id: query.warehouse_id, ...scope }, select: { id: true, name: true } })
    if (!warehouse) throw reportError(404, 'Almacén no disponible en este alcance')
  }
  if (query.location_id) {
    location = await prisma.stockLocation.findFirst({ where: { id: query.location_id,
      ...(warehouse ? { warehouse_id: warehouse.id } : {}), warehouse: scope }, select: { id: true, code: true, name: true } })
    if (!location) throw reportError(404, 'Ubicación no disponible en este alcance')
  }
  if (query.product_id) {
    const product = await prisma.product.findFirst({ where: { id: query.product_id, company_id: req.companyId, deleted: false }, select: { id: true } })
    if (!product) throw reportError(404, 'Producto no disponible en esta empresa')
  }
  return { warehouse, location: location ? { id: location.id, name: location.name || location.code } : null }
}
function authorizedReportWhere(req) {
  return { branch_id: req.branchId || { in: req.branchIds || [] }, branch: { company_id: req.companyId } }
}
module.exports = { resolveReportPeriod, reportDateWhere, validateReportScope, authorizedReportWhere, reportError }
