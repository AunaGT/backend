const { createReport, column: c, section: s, metric: m, chart } = require('../reportModel')
const place = location => location ? `${location.warehouse?.name || ''} · ${location.code}` : null
const iso = date => date ? new Date(date).toISOString() : null
function buildStockByLocationReport(data, meta) {
  const warehouses = new Map()
  const rows = data.rows.map(r => ({ warehouse: r.warehouse, location: r.location_name ? `${r.location} · ${r.location_name}` : r.location, skus: Number(r.skus), units: Number(r.units), value: Number(r.value) }))
  data.rows.forEach(r => {
    const key = r.warehouse_id
    const a = warehouses.get(key) || { warehouse: r.warehouse, skus: 0, units: 0, value: 0 }
    a.skus += Number(r.skus); a.units += Number(r.units); a.value += Number(r.value); warehouses.set(key, a)
  })
  const byWarehouse = [...warehouses.values()]
  const cols = [c('skus', 'SKUs por ubicación', 'integer'), c('units', 'Unidades', 'integer'), c('value', 'Valor a costo', 'money')]
  return createReport(meta, { id: 'stock-by-location', title: 'Existencias por almacén y ubicación', summary: [m('warehouses', 'Almacenes', byWarehouse.length), m('locations', 'Ubicaciones', rows.length), m('units', 'Unidades', rows.reduce((s, r) => s + r.units, 0)), m('value', 'Valor a costo', rows.reduce((s, r) => s + r.value, 0), 'money')],
    sections: [s('by-warehouse', 'Por almacén', [c('warehouse', 'Almacén'), ...cols], byWarehouse), s('by-location', 'Por ubicación', [c('warehouse', 'Almacén'), c('location', 'Ubicación'), ...cols], rows)],
    charts: [chart('by-warehouse', 'Valor actual por almacén', byWarehouse, 'warehouse', 'value')], notes: ['Los SKUs se cuentan por ubicación; no son productos únicos de la empresa.'] })
}
function buildKardexReport(data, meta) {
  const rows = data.movements.map(r => ({ date: iso(r.created_at), product: r.product?.name || null, location: place(r.location), reason: r.reason,
    incoming: r.qty > 0 ? r.qty : 0, outgoing: r.qty < 0 ? -r.qty : 0, balance: r.balance }))
  return createReport(meta, { id: 'kardex', title: 'Kardex por ubicación', summary: [m('movements', 'Movimientos', rows.length), m('in', 'Entradas', rows.reduce((s, r) => s + r.incoming, 0)), m('out', 'Salidas', rows.reduce((s, r) => s + r.outgoing, 0))],
    sections: [s('movements', 'Movimientos', [c('date', 'Fecha', 'datetime'), c('product', 'Producto'), c('location', 'Ubicación'), c('reason', 'Motivo'), c('incoming', 'Entrada', 'integer'), c('outgoing', 'Salida', 'integer'), c('balance', 'Saldo registrado', 'integer')], rows)],
    charts: [], notes: ['El saldo corresponde al producto y ubicación de cada movimiento; no se suma como saldo final global.'] })
}
function buildInternalMovesReport(data, meta) {
  const groups = new Map()
  for (const r of data.movements) {
    const key = `${r.group_id || r.id}|${r.product?.id || r.product_id}`
    const g = groups.get(key) || { date: iso(r.created_at), product: r.product?.name || null, origins: new Set(), destinations: new Set(), out: 0, in: 0, user: r.createdBy?.name || null }
    if (r.qty < 0) { g.origins.add(place(r.location)); g.out -= r.qty } else { g.destinations.add(place(r.location)); g.in += r.qty }
    groups.set(key, g)
  }
  const rows = [...groups.values()].map(g => ({ date: g.date, product: g.product, origin: [...g.origins].join('; ') || null,
    destination: [...g.destinations].join('; ') || null, units: g.out || g.in, user: g.user }))
  const incomplete = [...groups.values()].some(g => !g.out || !g.in || g.out !== g.in)
  return createReport(meta, { id: 'internal-moves', title: 'Movimientos internos', summary: [m('movements', 'Movimientos', rows.length), m('units', 'Unidades movidas', rows.reduce((s, r) => s + r.units, 0))],
    sections: [s('detail', 'Detalle de movimientos', [c('date', 'Fecha', 'datetime'), c('product', 'Producto'), c('origin', 'Origen'), c('destination', 'Destino'), c('units', 'Unidades', 'integer'), c('user', 'Responsable')], rows)], charts: [],
    notes: ['Cada movimiento se cuenta una vez, sin duplicar sus entradas y salidas.', ...(incomplete ? ['Hay movimientos históricos incompletos; no se infiere su origen o destino ausente.'] : [])] })
}
function buildReplenishmentReport(data, meta) {
  const rows = data.rows.map(r => ({ product: r.product_name, location: `${r.warehouse_name} · ${r.location_code}`, stock: Number(r.stock), minimum: Number(r.min_stock), gap: Number(r.missing),
    origin: r.from_location_code ? `${r.from_warehouse_name} · ${r.from_location_code}` : null, available: r.from_stock == null ? null : Number(r.from_stock), suggested: Number(r.suggested_qty || 0) }))
  return createReport(meta, { id: 'replenishment', title: 'Reposición interna sugerida', summary: [m('locations', 'Ubicaciones bajo mínimo', rows.length), m('available', 'Con origen disponible', rows.filter(r => r.origin).length), m('purchase', 'Sin origen disponible', rows.filter(r => !r.origin).length)],
    sections: [s('suggestions', 'Sugerencias de reposición', [c('product', 'Producto'), c('location', 'Destino'), c('stock', 'Existencia', 'integer'), c('minimum', 'Mínimo', 'integer'), c('gap', 'Faltante', 'integer'), c('origin', 'Traer de'), c('available', 'Disponible', 'integer'), c('suggested', 'Mover', 'integer')], rows)], charts: [], notes: ['Sugerencias dentro de cada sucursal; no son órdenes ni traslados intersucursal.'] })
}
function buildOccupancyReport(data, meta) {
  const rows = data.rows.map(r => ({ warehouse: r.warehouse, location: r.location_name ? `${r.location} · ${r.location_name}` : r.location, skus: Number(r.skus), units: Number(r.units), pickable: r.pickable }))
  const empty = rows.filter(r => !r.skus)
  return createReport(meta, { id: 'occupancy', title: 'Ocupación de ubicaciones', summary: [m('locations', 'Ubicaciones', rows.length), m('empty', 'Vacías', empty.length), m('single', 'Con un SKU', rows.filter(r => r.skus === 1).length), m('occupied', 'Ubicaciones ocupadas', rows.length ? (rows.length - empty.length) / rows.length * 100 : 0, 'percent')],
    sections: [s('by-location', 'Por ubicación', [c('warehouse', 'Almacén'), c('location', 'Ubicación'), c('skus', 'SKUs', 'integer'), c('units', 'Unidades', 'integer'), c('pickable', 'Despacha', 'boolean')], rows), s('empty-locations', 'Ubicaciones vacías', [c('warehouse', 'Almacén'), c('location', 'Ubicación')], empty)], charts: [], notes: ['Ocupación por presencia de productos activos, no porcentaje de capacidad física.'] })
}
module.exports = { buildStockByLocationReport, buildKardexReport, buildInternalMovesReport, buildReplenishmentReport, buildOccupancyReport }
