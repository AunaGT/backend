const { reportError } = require('./reportFilters')
const TYPES = new Set(['text', 'integer', 'decimal', 'money', 'percent', 'date', 'datetime', 'boolean'])
function createReportMeta(req, branding, scope, period, locations = {}, nowIso = new Date().toISOString()) {
  const buffer = branding.logoBuffer
  const png = Buffer.isBuffer(buffer) && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg = Buffer.isBuffer(buffer) && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
  return { generatedAt: nowIso, generatedBy: req.user?.name || null, timezone: branding.timezone || 'America/Guatemala', currency: branding.currency_code || 'GTQ',
    scope: { companyId: req.companyId, label: scope.label, branches: scope.branches.map(b => ({ id: b.id, name: b.name })),
      warehouse: locations.warehouse ? { id: locations.warehouse.id, name: locations.warehouse.name } : null,
      location: locations.location ? { id: locations.location.id, name: locations.location.name } : null },
    period, branding: { companyName: branding.company_name || 'Empresa', logoDataUrl: png || jpeg ? `data:image/${png ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}` : null } }
}
function validCell(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return value
  throw reportError(500, 'Valor inválido al preparar el reporte', 'INVALID_REPORT_DATA')
}
function unique(items) {
  const ids = new Set()
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw reportError(500, 'Identificadores duplicados en reporte', 'INVALID_REPORT_DATA')
    ids.add(item.id)
  }
}
function createReport(meta, content) {
  const { sections, summary = [], charts = [], notes = [] } = content
  assertReportSize(sections.reduce((sum, s) => sum + s.rows.length, 0))
  unique(sections); unique(summary); unique(charts)
  const projected = sections.map(section => {
    unique(section.columns)
    for (const c of section.columns) if (!TYPES.has(c.type) || (c.quantityDecimals!=null && (!Number.isInteger(c.quantityDecimals) || c.quantityDecimals<0 || c.quantityDecimals>6))) throw reportError(500, 'Tipo o precisión de columna inválido', 'INVALID_REPORT_DATA')
    const project = row => Object.fromEntries(section.columns.filter(c => Object.hasOwn(row, c.id)).map(c => [c.id, validCell(row[c.id])]))
    return { id: section.id, title: section.title, columns: section.columns.map(c => ({ id: c.id, label: c.label, type: c.type, align: c.align,...(c.quantityDecimals!=null ? {quantityDecimals:c.quantityDecimals} : {}) })),
      rows: section.rows.map(row => Object.fromEntries(section.columns.map(c => [c.id, validCell(row[c.id] ?? null)]))), totals: section.totals ? project(section.totals) : null }
  })
  return { ...meta, id: content.id, title: content.title, summary: summary.map(m => ({ id: m.id, label: m.label, type: m.type, value: validCell(m.value) })),
    sections: projected, charts: charts.map(c => ({ id: c.id, sectionId: c.sectionId, title: c.title, kind: c.kind, valueType: c.valueType,
      points: c.points.map(p => ({ label: String(p.label), value: validCell(p.value) })) })), notes: notes.map(String) }
}
function assertReportSize(count) {
  if (count > 10000) throw reportError(422, 'El reporte supera 10.000 filas. Reduce el período o alcance.', 'REPORT_TOO_LARGE')
}
const column = (id, label, type = 'text',quantityDecimals) => ({ id, label, type, align: ['integer', 'decimal', 'money', 'percent'].includes(type) ? 'right' : 'left',...(quantityDecimals!=null ? {quantityDecimals} : {}) })
const section = (id, title, columns, rows, totals = null) => ({ id, title, columns, rows, totals })
const metric = (id, label, value, type = 'integer') => ({ id, label, value, type })
const chart = (sectionId, title, rows, labelKey, valueKey, valueType = 'money', kind = 'bar') => ({
  id: sectionId, sectionId, title, kind, valueType, points: rows.map(r => ({ label: r[labelKey], value: r[valueKey] })),
})
module.exports = { createReportMeta, createReport, assertReportSize, column, section, metric, chart }
