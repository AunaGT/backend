const { createReport, column: c, section: s, metric: m, chart } = require('../reportModel')
const {D,exact,baseUnit,dimension,quantityTotal}=require('../quantities')
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
  const cols = [c('skus', 'SKUs por ubicación', 'integer'), c('value', 'Valor a costo', 'money')]
  return createReport(meta, { id: 'stock-by-location', title: 'Existencias por almacén y ubicación', summary: [m('warehouses', 'Almacenes', byWarehouse.length), m('locations', 'Ubicaciones', rows.length), m('value', 'Valor a costo', rows.reduce((s, r) => s + r.value, 0), 'money')],
    sections: [s('by-warehouse', 'Por almacén', [c('warehouse', 'Almacén'), ...cols], byWarehouse), s('by-location', 'Por ubicación', [c('warehouse', 'Almacén'), c('location', 'Ubicación'), ...cols], rows)],
    charts: [chart('by-warehouse', 'Valor actual por almacén', byWarehouse, 'warehouse', 'value')], notes: ['Los SKUs se cuentan por ubicación; no son productos únicos de la empresa.'] })
}
function buildKardexReport(data, meta) {
  const rows = data.movements.map(r => ({ date: iso(r.created_at), product: r.product?.name || null, location: place(r.location), reason: r.reason,
    dimension:dimension(r),unit:baseUnit(r),incoming:D(r.qty).gt(0)?exact(r.qty):0,outgoing:D(r.qty).lt(0)?exact(typeof r.qty==='number'?-r.qty:D(r.qty).neg().toFixed()):0,balance:exact(r.balance) }))
  return createReport(meta, { id: 'kardex', title: 'Kardex por ubicación', summary: [m('movements', 'Movimientos', rows.length), m('in', 'Entradas (misma unidad)', quantityTotal(rows,'incoming'),'decimal'), m('out', 'Salidas (misma unidad)', quantityTotal(rows,'outgoing'),'decimal')],
    sections: [s('movements', 'Movimientos', [c('date', 'Fecha', 'datetime'), c('product', 'Producto'), c('location', 'Ubicación'), c('reason', 'Motivo'), c('unit','Unidad base'),c('incoming', 'Entrada', 'decimal',6), c('outgoing', 'Salida', 'decimal',6), c('balance', 'Saldo registrado', 'decimal',6)], rows)],
    charts: [], notes: ['El saldo corresponde al producto y ubicación de cada movimiento; no se suma como saldo final global.'] })
}
function buildInternalMovesReport(data, meta) {
  const groups = new Map()
  for (const r of data.movements) {
    const key = `${r.group_id || r.id}|${r.product?.id || r.product_id}`
    const g = groups.get(key) || { date: iso(r.created_at), product: r.product?.name || null, origins: new Set(), destinations: new Set(), dimension:dimension(r),unit:baseUnit(r),legacy:typeof r.qty==='number',out:D(0),in:D(0),user: r.createdBy?.name || null }
    if (D(r.qty).lt(0)) { g.origins.add(place(r.location)); g.out=g.out.sub(D(r.qty)) } else { g.destinations.add(place(r.location)); g.in=g.in.add(D(r.qty)) }
    groups.set(key, g)
  }
  const rows = [...groups.values()].map(g => ({ date: g.date, product: g.product, origin: [...g.origins].join('; ') || null,
    destination: [...g.destinations].join('; ') || null, dimension:g.dimension,unit:g.unit,units:g.legacy?(g.out.gt(0)?g.out:g.in).toNumber():(g.out.gt(0)?g.out:g.in).toFixed(),user: g.user }))
  const incomplete = [...groups.values()].some(g => g.out.isZero() || g.in.isZero() || !g.out.eq(g.in))
  return createReport(meta, { id: 'internal-moves', title: 'Movimientos internos', summary: [m('movements', 'Movimientos', rows.length), m('units', 'Cantidad movida (misma unidad)', quantityTotal(rows,'units'),'decimal')],
    sections: [s('detail', 'Detalle de movimientos', [c('date', 'Fecha', 'datetime'), c('product', 'Producto'), c('origin', 'Origen'), c('destination', 'Destino'), c('unit','Unidad base'),c('units', 'Cantidad', 'decimal',6), c('user', 'Responsable')], rows)], charts: [],
    notes: ['Cada movimiento se cuenta una vez, sin duplicar sus entradas y salidas.', ...(incomplete ? ['Hay movimientos históricos incompletos; no se infiere su origen o destino ausente.'] : [])] })
}
function buildReplenishmentReport(data, meta) {
  const rows = data.rows.map(r => ({ product: r.product_name, location: `${r.warehouse_name} · ${r.location_code}`, unit:baseUnit(r),stock:exact(r.stock),minimum:exact(r.min_stock),gap:exact(r.missing),
    origin: r.from_location_code ? `${r.from_warehouse_name} · ${r.from_location_code}` : null, available:r.from_stock==null?null:exact(r.from_stock),suggested:exact(r.suggested_qty??0) }))
  return createReport(meta, { id: 'replenishment', title: 'Reposición interna sugerida', summary: [m('locations', 'Ubicaciones bajo mínimo', rows.length), m('available', 'Con origen disponible', rows.filter(r => r.origin).length), m('purchase', 'Sin origen disponible', rows.filter(r => !r.origin).length)],
    sections: [s('suggestions', 'Sugerencias de reposición', [c('product', 'Producto'), c('location', 'Destino'), c('unit','Unidad base'),c('stock', 'Existencia', 'decimal',6), c('minimum', 'Mínimo', 'decimal',6), c('gap', 'Faltante', 'decimal',6), c('origin', 'Traer de'), c('available', 'Disponible', 'decimal',6), c('suggested', 'Mover', 'decimal',6)], rows)], charts: [], notes: ['Sugerencias dentro de cada sucursal; no son órdenes ni traslados intersucursal.'] })
}
function buildOccupancyReport(data, meta) {
  const rows = data.rows.map(r => ({ warehouse: r.warehouse, location: r.location_name ? `${r.location} · ${r.location_name}` : r.location, skus: Number(r.skus), units: Number(r.units), pickable: r.pickable }))
  const empty = rows.filter(r => !r.skus)
  return createReport(meta, { id: 'occupancy', title: 'Ocupación de ubicaciones', summary: [m('locations', 'Ubicaciones', rows.length), m('empty', 'Vacías', empty.length), m('single', 'Con un SKU', rows.filter(r => r.skus === 1).length), m('occupied', 'Ubicaciones ocupadas', rows.length ? (rows.length - empty.length) / rows.length * 100 : 0, 'percent')],
    sections: [s('by-location', 'Por ubicación', [c('warehouse', 'Almacén'), c('location', 'Ubicación'), c('skus', 'SKUs', 'integer'), c('pickable', 'Despacha', 'boolean')], rows), s('empty-locations', 'Ubicaciones vacías', [c('warehouse', 'Almacén'), c('location', 'Ubicación')], empty)], charts: [], notes: ['Ocupación por presencia de productos activos, no porcentaje de capacidad física.'] })
}
module.exports = { buildStockByLocationReport, buildKardexReport, buildInternalMovesReport, buildReplenishmentReport, buildOccupancyReport }
