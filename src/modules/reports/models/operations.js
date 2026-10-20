const { createReport, column: c, section: s, metric: m, chart } = require('../reportModel')
const {D,exact,baseUnit}=require('../quantities')
const iso = value => value ? new Date(value).toISOString() : null
function buildAlertsReport(data, meta) {
  const cols = [c('product', 'Producto'), c('category', 'Categoría'), c('unit','Unidad base'),c('stock', 'Existencia', 'decimal',6), c('location', 'Ubicación'), c('minimum', 'Mínimo', 'decimal',6), c('gap', 'Faltante', 'decimal',6), c('value', 'Costo de reposición', 'money'), c('supplier', 'Proveedor')]
  const project = rows => rows.map(p => ({ product: p.name, category: p.category?.name || 'Sin categoría', unit:baseUnit(p),stock:exact(p.stock), location: data.whereIs?.get(p.id) || null,
    minimum:exact(p.min_stock),gap:D(p.min_stock).sub(D(p.stock)).gt(0)?D(p.min_stock).sub(D(p.stock)).toFixed():'0',value:D(p.min_stock).sub(D(p.stock)).gt(0)?D(p.min_stock).sub(D(p.stock)).mul(D(p.cost)).toDecimalPlaces(2).toNumber():0, supplier: p.supplier?.name || null }))
  return createReport(meta, { id: 'alerts', title: 'Pendientes y alertas',
    summary: [m('at-risk', 'Productos bajo mínimo', data.summary.atRiskCount), m('critical', 'Sin existencia', data.summary.criticalCount), m('cost', 'Costo de reposición', data.summary.reorderGapValue, 'money'), m('open', 'Alertas abiertas', data.summary.openSystemAlerts)],
    sections: [s('action-list', 'Reposición priorizada', cols, project(data.actionList)), s('critical', 'Productos sin existencia', cols, project(data.critical)),
      s('by-category', 'Productos en riesgo por categoría', [c('category', 'Categoría'), c('enRiesgo', 'Bajo mínimo', 'integer'), c('sinStock', 'Sin existencia', 'integer'), c('bajoConStock', 'Con existencia bajo mínimo', 'integer')], data.categoryBreakdown),
      s('system-alerts', 'Alertas abiertas del sistema', [c('date', 'Fecha', 'datetime'), c('title', 'Alerta'), c('product', 'Producto'), c('type', 'Tipo'), c('priority', 'Prioridad'), c('status', 'Estado'), c('assignedTo', 'Asignado a')],
        data.systemAlerts.map(a => ({ date: iso(a.timestamp), title: a.title, product: a.product?.name || null, type: a.type?.name || null, priority: a.priority?.name || null, status: a.status?.name || null, assignedTo: a.assignedTo?.name || null })))],
    charts: [chart('by-category', 'Productos bajo mínimo por categoría', data.categoryBreakdown, 'category', 'enRiesgo', 'integer')], notes: ['Existencias, mínimos y alertas al preparar el reporte.'] })
}
function buildMerchandiseReport(data, meta) {
  return createReport(meta, { id: 'merchandise', title: 'Ingresos de mercadería',
    summary: [m('records', 'Ingresos', data.summary.records), m('received', 'Costo recibido', data.summary.totalAmount, 'money'), m('paid', 'Registros pagados', data.summary.paidCount), m('partial', 'Con pago parcial', data.summary.partialCount), m('pending', 'Pendientes', data.summary.pendingCount)],
    sections: [s('detail', 'Detalle de ingresos', [c('date', 'Fecha', 'date'), c('branch', 'Sucursal'), c('supplier', 'Proveedor'), c('registeredBy', 'Registrado por'), c('status', 'Estado de pago'), c('total', 'Costo recibido', 'money')], data.detail, { total: data.summary.totalAmount }),
      s('by-supplier', 'Costo recibido por proveedor', [c('supplier', 'Proveedor'), c('count', 'Ingresos', 'integer'), c('amount', 'Costo recibido', 'money')], data.bySupplier)],
    charts: [chart('by-supplier', 'Costo recibido por proveedor', data.bySupplier, 'supplier', 'amount')], notes: ['El costo recibido no equivale al monto efectivamente abonado.'] })
}
const STATUS = { DRAFT: 'Borrador', OPEN: 'En conteo', IN_PROGRESS: 'En conteo', SUBMITTED: 'En revisión', FIRST_APPROVED: 'Primera aprobación', APPROVED: 'Cerrado y guardado', CANCELLED: 'Cancelado' }
function buildInventoryCountsReport(data, meta) {
  return createReport(meta, { id: 'inventory-counts', title: 'Historial de inventariados',
    summary: [m('sessions', 'Sesiones', data.sessions.length), m('difference', 'Valor de diferencias contadas', data.summary.sumValueDiff, 'money'), m('loss', 'Valor de merma', data.summary.sumMerma, 'money')],
    sections: [s('sessions', 'Sesiones de inventariado', [c('session', 'Sesión'), c('status', 'Estado'), c('createdAt', 'Creación', 'datetime'), c('lines', 'Líneas', 'integer'), c('counted', 'Contadas', 'integer'), c('differenceValue', 'Valor de diferencia', 'money'), c('lossValue', 'Valor de merma', 'money'), c('approvedAt', 'Aprobación', 'datetime'), c('approvedBy', 'Aprobado por'), c('createdBy', 'Creado por')],
      data.sessions.map(({ s: session, counted, valueDiff, mermaValue }) => ({ session: session.name || session.id, status: STATUS[session.status] || session.status, createdAt: iso(session.created_at), lines: session._count.lines, counted, differenceValue: valueDiff, lossValue: mermaValue, approvedAt: iso(session.approved_at), approvedBy: session.approvedBy?.name || null, createdBy: session.createdBy?.name || null })), { differenceValue: data.summary.sumValueDiff, lossValue: data.summary.sumMerma })],
    charts: [chart('sessions', 'Sesiones por estado', Object.entries(data.byStatus).map(([status, count]) => ({ status: STATUS[status] || status, count })), 'status', 'count', 'integer')], notes: ['Diferencias y merma se calculan solo sobre líneas contadas.'] })
}
module.exports = { buildAlertsReport, buildMerchandiseReport, buildInventoryCountsReport }
