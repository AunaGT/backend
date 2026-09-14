/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Reportes de almacenes y ubicaciones: existencias, kardex, movimientos
 * internos, reposición sugerida y ocupación. Todos salen en PDF y CSV con el
 * mismo papel que el resto (`emit`), así que cada reporte de aquí es solo su
 * consulta y sus columnas.
 */

const { Prisma } = require('@prisma/client')
const { DateTime } = require('luxon')
const { prisma } = require('../../models/prisma')
const { getBrandingForPdf } = require('../../utils/pdfBranding')
const { replenishmentSuggestions } = require('../../services/stockLocations')
const {
  reportScope, scopeBranchIds, periodRange, number, makeMoney,
  newDoc, header, footer, sectionTitle, drawTable, drawSummaryCards, sendCsv,
} = require('./controller')

const ZONE = 'America/Guatemala'
const now = () => DateTime.now().setZone(ZONE).toFormat('yyyy-LL-dd HH:mm')
const day = (d) => DateTime.fromJSDate(d).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm')

/** Sucursales del reporte como SQL, o null si no hay ninguna (reporte vacío). */
function branchIdsSql(req) {
  const ids = scopeBranchIds(req)
  if (!ids.length) return null
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))
}

/** Filtro opcional de almacén / ubicación, validado contra el alcance por el JOIN. */
function locationFilter(req) {
  const { warehouse_id: wid, location_id: lid } = req.query || {}
  return Prisma.sql`
    ${wid ? Prisma.sql`AND w.id = ${String(wid)}::uuid` : Prisma.empty}
    ${lid ? Prisma.sql`AND l.id = ${String(lid)}::uuid` : Prisma.empty}
  `
}

/**
 * Manda el reporte en el formato pedido. Un solo lugar decide PDF o CSV: los
 * reportes solo describen qué se ve.
 * @param {{title, filename, periodLabel, summary, sections}} report
 *   summary: [{ label, value }] — sale como tarjetas en PDF y como metadatos en CSV
 *   sections: [{ title, columns, rows, widths, align }]
 */
async function emit(req, res, report, branding) {
  branding = branding || await getBrandingForPdf(prisma, req.companyId)
  const scope = await reportScope(req)
  const wantsCsv = ['csv', 'excel'].includes(String(req.query.format || 'pdf').toLowerCase())

  if (wantsCsv) {
    sendCsv(res, report.filename, [
      report.title.toUpperCase(),
      `Periodo,${report.periodLabel}`,
      `Sucursal,${scope.label}`,
      `Generado,${now()}`,
      ...report.summary.map((c) => `${c.label},${c.value}`),
    ], report.sections)
    return
  }

  const doc = newDoc(res, report.title)
  header(doc, report.title, report.periodLabel, branding.company_name, branding.logoBuffer, scope.label)
  if (report.summary.length) {
    sectionTitle(doc, 'Resumen')
    drawSummaryCards(doc, report.summary)
  }
  for (const sec of report.sections) {
    sectionTitle(doc, sec.title)
    drawTable(doc, sec.columns, sec.rows, sec.widths, {
      align: sec.align, headerAlign: sec.align,
    })
  }
  footer(doc, branding.company_name)
  doc.end()
}

/** GET /api/reports/stock-by-location — cuánto hay y cuánto vale, por almacén y por anaquel. */
async function stockByLocationReport(req, res, next) {
  try {
    const branches = branchIdsSql(req)
    const rows = branches ? await prisma.$queryRaw`
      SELECT w.name AS warehouse, l.code AS location, l.name AS location_name,
             COUNT(*) FILTER (WHERE psl.stock <> 0)::int AS skus,
             COALESCE(SUM(psl.stock), 0)::int AS units,
             COALESCE(SUM(psl.stock * p.cost), 0)::numeric AS value
      FROM product_stock_locations psl
      JOIN products p ON p.id = psl.product_id AND NOT p.deleted
      JOIN stock_locations l ON l.id = psl.location_id
      JOIN warehouses w ON w.id = l.warehouse_id
      WHERE w.branch_id IN (${branches}) ${locationFilter(req)}
      GROUP BY w.name, l.code, l.name, w.dispatch_priority, l.dispatch_priority
      ORDER BY w.dispatch_priority, w.name, l.dispatch_priority, l.code
    ` : []

    const branding = await getBrandingForPdf(prisma, req.companyId)
    const money = makeMoney(branding.currency_code)
    const byWarehouse = new Map()
    let skus = 0, units = 0, value = 0
    for (const r of rows) {
      const agg = byWarehouse.get(r.warehouse) || { skus: 0, units: 0, value: 0 }
      agg.skus += r.skus; agg.units += r.units; agg.value += number(r.value)
      byWarehouse.set(r.warehouse, agg)
      skus += r.skus; units += r.units; value += number(r.value)
    }

    await emit(req, res, {
      title: 'Existencias por Almacén y Ubicación',
      filename: 'existencias-por-almacen',
      periodLabel: `Al ${now()}`,
      summary: [
        { label: 'Almacenes', value: String(byWarehouse.size) },
        { label: 'Ubicaciones', value: String(rows.length) },
        { label: 'SKUs', value: String(skus) },
        { label: 'Unidades', value: String(units) },
        { label: 'Valor', value: money(value) },
      ],
      sections: [
        {
          title: 'Por Almacén',
          columns: ['Almacén', 'SKUs', 'Unidades', 'Valor'],
          rows: [...byWarehouse.entries()].map(([name, a]) => [name, String(a.skus), String(a.units), money(a.value)]),
          widths: [240, 80, 90, 110],
          align: ['left', 'right', 'right', 'right'],
        },
        {
          title: 'Por Ubicación',
          columns: ['Almacén', 'Ubicación', 'SKUs', 'Unidades', 'Valor'],
          rows: rows.map((r) => [
            r.warehouse,
            r.location_name ? `${r.location} — ${r.location_name}` : r.location,
            String(r.skus), String(r.units), money(number(r.value)),
          ]),
          widths: [140, 160, 60, 70, 90],
          align: ['left', 'left', 'right', 'right', 'right'],
        },
      ],
    }, branding)
  } catch (e) { next(e) }
}

const REASON_ES = {
  INITIAL: 'Saldo inicial', PURCHASE: 'Ingreso', SALE: 'Venta', SALE_RETURN: 'Devolución',
  ORDER_FULFILL: 'Pedido', TRANSFER_OUT: 'Traslado enviado', TRANSFER_IN: 'Traslado recibido',
  TRANSFER_CANCEL: 'Traslado cancelado', INTERNAL_MOVE: 'Movimiento interno',
  COUNT_ADJUST: 'Ajuste por conteo', MANUAL_ADJUST: 'Ajuste manual',
  KIT_ASSEMBLE: 'Kit armado', KIT_DISASSEMBLE: 'Kit desarmado',
}

/** Movimientos del alcance en el período, del más viejo al más nuevo. */
async function movementsInPeriod(req, { startUtc, endUtc, reason }) {
  const ids = scopeBranchIds(req)
  if (!ids.length) return []
  const { product_id: pid, location_id: lid, warehouse_id: wid } = req.query || {}
  return prisma.stockMovement.findMany({
    where: {
      branch_id: { in: ids },
      created_at: { gte: startUtc, lte: endUtc },
      ...(reason ? { reason } : {}),
      ...(pid ? { product_id: String(pid) } : {}),
      ...(lid ? { location_id: String(lid) } : {}),
      ...(wid ? { location: { warehouse_id: String(wid) } } : {}),
    },
    select: {
      qty: true, balance: true, reason: true, ref_type: true, notes: true,
      created_at: true, group_id: true,
      product: { select: { name: true } },
      location: { select: { code: true, warehouse: { select: { name: true } } } },
      createdBy: { select: { name: true } },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    take: 5000, // ponytail: tope duro; el kardex se consulta por producto o por ubicación
  })
}

/** GET /api/reports/kardex — entradas, salidas y saldo, ubicación por ubicación. */
async function kardexReport(req, res, next) {
  try {
    const { period = 'month', year, month, quarter, semester } = req.query
    const { startUtc, endUtc, label } = periodRange(period, year, { month, quarter, semester })
    const rows = await movementsInPeriod(req, { startUtc, endUtc })

    let entradas = 0, salidas = 0
    for (const r of rows) (r.qty > 0 ? (entradas += r.qty) : (salidas -= r.qty))

    await emit(req, res, {
      title: 'Kardex por Ubicación',
      filename: 'kardex-por-ubicacion',
      periodLabel: label,
      summary: [
        { label: 'Movimientos', value: String(rows.length) },
        { label: 'Entradas', value: String(entradas) },
        { label: 'Salidas', value: String(salidas) },
      ],
      sections: [{
        title: 'Movimientos',
        columns: ['Fecha', 'Producto', 'Ubicación', 'Motivo', 'Entrada', 'Salida', 'Saldo'],
        rows: rows.map((r) => [
          day(r.created_at),
          r.product?.name || '—',
          `${r.location.warehouse.name} · ${r.location.code}`,
          REASON_ES[r.reason] || r.reason,
          r.qty > 0 ? String(r.qty) : '',
          r.qty < 0 ? String(-r.qty) : '',
          String(r.balance),
        ]),
        widths: [85, 120, 110, 85, 50, 50, 50],
        align: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
      }],
    })
  } catch (e) { next(e) }
}

/** GET /api/reports/internal-moves — qué se movió de anaquel a anaquel y quién lo movió. */
async function internalMovesReport(req, res, next) {
  try {
    const { period = 'month', year, month, quarter, semester } = req.query
    const { startUtc, endUtc, label } = periodRange(period, year, { month, quarter, semester })
    const rows = await movementsInPeriod(req, { startUtc, endUtc, reason: 'INTERNAL_MOVE' })

    // Cada movimiento son dos filas del libro con el mismo grupo: la negativa
    // dice de dónde salió y la positiva a dónde entró.
    const byKey = new Map()
    for (const r of rows) {
      const key = `${r.group_id || r.created_at.getTime()}|${r.product?.name || ''}`
      const item = byKey.get(key) || {
        date: r.created_at, product: r.product?.name || '—', from: '—', to: '—',
        qty: 0, user: r.createdBy?.name || '—', notes: r.notes || '',
      }
      const place = `${r.location.warehouse.name} · ${r.location.code}`
      if (r.qty < 0) { item.from = place; item.qty = -r.qty } else { item.to = place }
      byKey.set(key, item)
    }
    const moves = [...byKey.values()].sort((a, b) => b.date - a.date)
    const units = moves.reduce((s, m) => s + m.qty, 0)

    await emit(req, res, {
      title: 'Movimientos Internos',
      filename: 'movimientos-internos',
      periodLabel: label,
      summary: [
        { label: 'Movimientos', value: String(moves.length) },
        { label: 'Unidades movidas', value: String(units) },
      ],
      sections: [{
        title: 'Detalle',
        columns: ['Fecha', 'Producto', 'Origen', 'Destino', 'Unidades', 'Usuario'],
        rows: moves.map((m) => [day(m.date), m.product, m.from, m.to, String(m.qty), m.user]),
        widths: [85, 120, 105, 105, 55, 80],
        align: ['left', 'left', 'left', 'left', 'right', 'left'],
      }],
    })
  } catch (e) { next(e) }
}

/** GET /api/reports/replenishment — la lista para el personal de bodega. */
async function replenishmentReport(req, res, next) {
  try {
    const ids = scopeBranchIds(req)
    // Es una sugerencia de mover mercancía DENTRO de una sucursal: en
    // consolidado se recorren todas las del alcance.
    const rows = (await Promise.all(ids.map((id) => replenishmentSuggestions(prisma, id)))).flat()
    const conOrigen = rows.filter((r) => r.from_location_id)

    await emit(req, res, {
      title: 'Reposición Interna Sugerida',
      filename: 'reposicion-interna',
      periodLabel: `Al ${now()}`,
      summary: [
        { label: 'Ubicaciones bajo mínimo', value: String(rows.length) },
        { label: 'Se pueden reponer moviendo', value: String(conOrigen.length) },
        { label: 'Hay que comprar', value: String(rows.length - conOrigen.length) },
      ],
      sections: [{
        title: 'Sugerencias',
        columns: ['Producto', 'Ubicación', 'Hay', 'Mínimo', 'Falta', 'Traer de', 'Disponible', 'Mover'],
        rows: rows.map((r) => [
          r.product_name,
          `${r.warehouse_name} · ${r.location_code}`,
          String(r.stock), String(r.min_stock), String(r.missing),
          r.from_location_code ? `${r.from_warehouse_name} · ${r.from_location_code}` : 'Sin existencia en otra ubicación',
          r.from_stock != null ? String(r.from_stock) : '—',
          r.suggested_qty ? String(r.suggested_qty) : '—',
        ]),
        widths: [110, 95, 35, 45, 40, 110, 60, 45],
        align: ['left', 'left', 'right', 'right', 'right', 'left', 'right', 'right'],
      }],
    })
  } catch (e) { next(e) }
}

/** GET /api/reports/occupancy — qué anaquel está vacío, cuál lleno y cuál con un solo SKU. */
async function occupancyReport(req, res, next) {
  try {
    const branches = branchIdsSql(req)
    const rows = branches ? await prisma.$queryRaw`
      SELECT w.name AS warehouse, l.code AS location, l.name AS location_name, l.pickable,
             COUNT(psl.product_id) FILTER (WHERE psl.stock > 0)::int AS skus,
             COALESCE(SUM(GREATEST(psl.stock, 0)), 0)::int AS units
      FROM stock_locations l
      JOIN warehouses w ON w.id = l.warehouse_id
      LEFT JOIN product_stock_locations psl ON psl.location_id = l.id
      LEFT JOIN products p ON p.id = psl.product_id AND NOT p.deleted
      WHERE w.branch_id IN (${branches}) AND w.active AND l.active ${locationFilter(req)}
      GROUP BY w.name, l.code, l.name, l.pickable, w.dispatch_priority, l.dispatch_priority
      ORDER BY units DESC, w.name, l.code
    ` : []

    const vacias = rows.filter((r) => r.skus === 0)
    const unSolo = rows.filter((r) => r.skus === 1)

    await emit(req, res, {
      title: 'Ocupación de Ubicaciones',
      filename: 'ocupacion-ubicaciones',
      periodLabel: `Al ${now()}`,
      summary: [
        { label: 'Ubicaciones', value: String(rows.length) },
        { label: 'Vacías', value: String(vacias.length) },
        { label: 'Con un solo SKU', value: String(unSolo.length) },
        { label: 'Unidades', value: String(rows.reduce((s, r) => s + r.units, 0)) },
      ],
      sections: [
        {
          title: 'Por Ubicación',
          columns: ['Almacén', 'Ubicación', 'SKUs', 'Unidades', 'Despacha'],
          rows: rows.map((r) => [
            r.warehouse,
            r.location_name ? `${r.location} — ${r.location_name}` : r.location,
            String(r.skus), String(r.units), r.pickable ? 'Sí' : 'No',
          ]),
          widths: [140, 170, 60, 80, 70],
          align: ['left', 'left', 'right', 'right', 'left'],
        },
        {
          title: 'Ubicaciones Vacías',
          columns: ['Almacén', 'Ubicación'],
          rows: vacias.map((r) => [r.warehouse, r.location]),
          widths: [240, 240],
          align: ['left', 'left'],
        },
      ],
    })
  } catch (e) { next(e) }
}

module.exports = {
  stockByLocationReport,
  kardexReport,
  internalMovesReport,
  replenishmentReport,
  occupancyReport,
}
