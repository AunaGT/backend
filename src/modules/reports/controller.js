/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../../models/prisma')
const { DateTime } = require('luxon')
const PDFDocument = require('pdfkit')
const { getBrandingForPdf } = require('../../utils/pdfBranding')

// Brand & styles inspired by Products PDF
const BRAND = {
  primary: '#0b1220',      // dark slate
  secondary: '#0ea5a4',    // teal
  accent: '#f59e0b',       // amber
  muted: '#475569',        // slate-500
  border: '#e6eef6',       // light divider
}

// Utility: parse period range (supports: week, month, quarter, semester, year, all)
const { branchWhere } = require('../../middlewares/tenant')
const { inTransitTotals } = require('../../services/inTransit')

/** Sucursales que alcanza el reporte: la activa, o todas en vista consolidada. */
function scopeBranchIds(req) {
  return req.branchId ? [req.branchId] : (req.branchIds || [])
}

/**
 * Identifica el alcance del reporte para imprimirlo en el documento: una
 * sucursal concreta o el consolidado de la empresa (con los nombres de todas).
 */
async function reportScope(req) {
  const ids = scopeBranchIds(req)
  const branches = ids.length
    ? await prisma.branch.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
    : []
  const consolidated = !req.branchId
  const names = branches.map((b) => b.name)
  return {
    consolidated,
    branches,
    label: consolidated
      ? `Todas las sucursales — consolidado (${names.join(', ') || 'sin sucursales'})`
      : names[0] || 'Sucursal',
  }
}

/** Almacén y ubicación por los que el modal acotó el reporte, si los hay. */
function warehouseFilter(req) {
  const wid = req.query?.warehouse_id ? String(req.query.warehouse_id) : null
  const lid = req.query?.location_id ? String(req.query.location_id) : null
  return { wid, lid, active: Boolean(wid || lid) }
}

/**
 * Inventario desglosado por almacén. Gemelo de `stockByBranch`, pero un nivel
 * más abajo: aquí sí tiene sentido fuera del consolidado, porque una sola
 * sucursal puede tener bodega, sala y vitrina.
 */
async function stockByWarehouse(req) {
  const ids = scopeBranchIds(req)
  if (!ids.length) return []
  const { wid, lid } = warehouseFilter(req)
  const rows = await prisma.productStockLocation.findMany({
    where: {
      stock: { not: 0 },
      product: { deleted: false, deleted_at: null },
      location: {
        ...(lid ? { id: lid } : {}),
        warehouse: { branch_id: { in: ids }, active: true, ...(wid ? { id: wid } : {}) },
      },
    },
    select: {
      stock: true,
      product: { select: { cost: true } },
      location: { select: { warehouse: { select: { name: true }, }, }, },
    },
  })
  const agg = new Map()
  for (const r of rows) {
    const name = r.location.warehouse.name
    const a = agg.get(name) || { warehouse: name, skus: 0, units: 0, value: 0 }
    a.skus += 1
    a.units += number(r.stock)
    a.value += number(r.stock) * number(r.product?.cost)
    agg.set(name, a)
  }
  const out = [...agg.values()].map((a) => ({ ...a, value: Number(a.value.toFixed(2)) }))
  // Con un solo almacén el desglose no dice nada que no diga el total.
  return out.length > 1 ? out.sort((a, b) => b.value - a.value) : []
}

/**
 * Dónde está lo poco que queda: la ubicación con más existencia de cada
 * producto. Para que "faltan 3" venga con el "y los 2 que hay están en la
 * vitrina", que es lo que decide si se compra o se mueve.
 */
async function topLocationByProduct(req, productIds) {
  const ids = scopeBranchIds(req)
  const pids = [...new Set((productIds || []).filter(Boolean))]
  if (!ids.length || !pids.length) return new Map()
  const rows = await prisma.productStockLocation.findMany({
    where: {
      product_id: { in: pids },
      stock: { gt: 0 },
      location: { warehouse: { branch_id: { in: ids }, active: true } },
    },
    select: {
      product_id: true, stock: true,
      location: { select: { code: true, warehouse: { select: { name: true } } } },
    },
    orderBy: { stock: 'desc' },
  })
  const out = new Map()
  for (const r of rows) {
    if (out.has(r.product_id)) continue
    out.set(r.product_id, `${r.location.warehouse.name} · ${r.location.code} (${r.stock})`)
  }
  return out
}

/** Sustituye p.stock por el stock de las sucursales del reporte (in place). */
async function overlayReportBranchStock(products, req) {
  const ids = scopeBranchIds(req)
  if (!ids.length || !products?.length) return
  const { wid, lid, active } = warehouseFilter(req)
  if (active) {
    // Acotado a un almacén o ubicación: el stock del reporte es el de ahí.
    const rows = await prisma.productStockLocation.findMany({
      where: {
        product_id: { in: products.map((p) => p.id) },
        location: {
          ...(lid ? { id: lid } : {}),
          warehouse: { branch_id: { in: ids }, ...(wid ? { id: wid } : {}) },
        },
      },
      select: { product_id: true, stock: true },
    })
    const at = new Map()
    for (const r of rows) at.set(r.product_id, (at.get(r.product_id) || 0) + r.stock)
    for (const p of products) p.stock = at.get(p.id) ?? 0
    return
  }
  const rows = await prisma.productStock.findMany({
    where: { branch_id: { in: ids }, product_id: { in: products.map((p) => p.id) } },
    select: { product_id: true, stock: true },
  })
  const byId = new Map()
  for (const r of rows) byId.set(r.product_id, (byId.get(r.product_id) || 0) + r.stock)
  for (const p of products) p.stock = byId.get(p.id) ?? 0
}

/**
 * Inventario desglosado por sucursal. Vacío fuera del consolidado: ahí el
 * reporte entero ya es de una sola sucursal y el desglose sobraría.
 */
async function stockByBranch(req, scope) {
  if (!scope.consolidated || !scope.branches.length) return []
  const rows = await prisma.productStock.findMany({
    where: {
      branch_id: { in: scope.branches.map((b) => b.id) },
      product: { deleted: false, deleted_at: null },
    },
    select: { branch_id: true, stock: true, min_stock: true, product: { select: { cost: true } } },
  })
  const agg = new Map(
    scope.branches.map((b) => [b.id, { branch: b.name, skus: 0, units: 0, value: 0, sinStock: 0, bajoMin: 0 }])
  )
  for (const r of rows) {
    const a = agg.get(r.branch_id)
    if (!a) continue
    const st = number(r.stock)
    a.skus += 1
    a.units += st
    a.value += st * number(r.product?.cost)
    if (st === 0) a.sinStock += 1
    else if (st <= number(r.min_stock)) a.bajoMin += 1
  }
  return [...agg.values()].map((a) => ({ ...a, value: Number(a.value.toFixed(2)) }))
}

function periodRange(period, yearParam, opts = {}, zone = 'America/Guatemala') {
  const now = DateTime.now().setZone(zone)
  const isAll = String(yearParam || '').toLowerCase() === 'all'
  const baseYear = isAll ? now.year : (yearParam || now.year)
  let start, end, label = 'Mes'

  if (isAll || period === 'all') {
    start = DateTime.fromObject({ year: 2025, month: 1, day: 1 }, { zone })
    end = DateTime.fromObject({ year: now.year, month: 12, day: 31, hour: 23, minute: 59, second: 59 }, { zone })
    label = 'Todos (2025 - ' + now.year + ')'
  } else {
    switch (period) {
      case 'week': {
        const startOfWeek = now.startOf('week')
        start = startOfWeek
        end = startOfWeek.endOf('week')
        label = 'Semana'
        break
      }
      case 'month': {
        const m = Number(opts.month) || now.month
        start = DateTime.fromObject({ year: baseYear, month: m, day: 1 }, { zone })
        end = start.endOf('month')
        label = 'Mes ' + String(m).padStart(2, '0') + ' ' + baseYear
        break
      }
      case 'quarter': {
        const q = Number(opts.quarter) || Math.ceil(now.month / 3)
        const qStartMonth = (q - 1) * 3 + 1
        start = DateTime.fromObject({ year: baseYear, month: qStartMonth, day: 1 }, { zone })
        end = start.plus({ months: 2 }).endOf('month')
        label = 'Trimestre Q' + q + ' ' + baseYear
        break
      }
      case 'semester': {
        const s = Number(opts.semester) === 2 ? 2 : 1
        const sStartMonth = s === 1 ? 1 : 7
        start = DateTime.fromObject({ year: baseYear, month: sStartMonth, day: 1 }, { zone })
        end = start.plus({ months: 5 }).endOf('month')
        label = 'Semestre ' + s + ' ' + baseYear
        break
      }
      case 'year': {
        start = DateTime.fromObject({ year: baseYear, month: 1, day: 1 }, { zone })
        end = DateTime.fromObject({ year: baseYear, month: 12, day: 31, hour: 23, minute: 59, second: 59 }, { zone })
        label = 'Año ' + baseYear
        break
      }
      default: {
        // default month (current)
        start = DateTime.fromObject({ year: baseYear, month: now.month, day: 1 }, { zone })
        end = start.endOf('month')
        label = 'Mes ' + now.month + ' ' + baseYear
      }
    }
  }

  return {
    startUtc: start.toUTC().toJSDate(),
    endUtc: end.toUTC().toJSDate(),
    label
  }
}

function number(v) {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function makeMoney(currencyCode) {
  const code = (currencyCode && String(currencyCode).trim()) || 'GTQ'
  return (v) => new Intl.NumberFormat('es-GT', { style: 'currency', currency: code }).format(number(v))
}

function newDoc(res, title) {
  // Switch to US Letter for better print alignment (612 x 792 points) and slightly smaller margins
  const doc = new PDFDocument({ margin: 44, size: 'LETTER' })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${title.toLowerCase().replace(/\s+/g,'-')}.pdf"`)
  doc.pipe(res)
  // subtle background band
  const w = doc.page.width, h = doc.page.height
  doc.save()
  doc.rect(0, 0, w, 105).fill('#f8fafc') // reduced band height for Letter
  doc.restore()
  return doc
}

// Helper: add a new Letter page and redraw the subtle top band for visual continuity
function addPageWithBand(doc) {
  doc.addPage({ size: 'LETTER', margin: 44 })
  const w = doc.page.width
  doc.save()
  doc.rect(0, 0, w, 105).fill('#f8fafc')
  doc.restore()
}

// Helper: ensure there is enough vertical space for a block; if not, start a fresh page
function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (doc.y + needed > bottom) addPageWithBand(doc)
}

function header(doc, title, periodLabel, companyName = 'Depósito', logoBuffer = null, scopeLabel = null) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  let titleX = left
  let titleY = 32

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, left, 16, { fit: [44, 26] })
      titleX = left + 50
      titleY = 26
    } catch {
      /* sin logo */
    }
  }

  doc.fillColor(BRAND.primary).fontSize(20).text(title, titleX, titleY, { align: 'left', width: Math.max(80, right - titleX) })
  doc.fontSize(9).fillColor(BRAND.muted).text(`Generado: ${DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}  |  Período: ${periodLabel}`, titleX, doc.y + 2, { align: 'left', width: Math.max(80, right - titleX) })
  if (scopeLabel) {
    doc.fontSize(9).fillColor(BRAND.muted).text(`Sucursal: ${scopeLabel}`, titleX, doc.y + 1, { align: 'left', width: Math.max(80, right - titleX) })
  }
  doc.moveTo(left, doc.y + 4).lineTo(right, doc.y + 4).lineWidth(1).strokeColor(BRAND.border).stroke()
  doc.moveDown(0.6)
}

function footer(doc, companyName = 'Depósito') {
  const bottom = doc.page.height - doc.page.margins.bottom + 12
  doc.fontSize(8).fillColor(BRAND.muted)
    .text(`Reporte generado por ${companyName}`, doc.page.margins.left, bottom, { align: 'center' })
}

function sectionTitle(doc, text) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const usableWidth = right - left
  // Make sure the title never gets stranded at the very bottom
  ensureSpace(doc, 40)
  doc.moveDown(0.5)
  // centered, bold, slightly larger for stronger emphasis
  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.primary)
    .text(text, left, undefined, { width: usableWidth, align: 'center' })
  // underline divider
  doc.moveTo(left, doc.y + 3).lineTo(right, doc.y + 3).lineWidth(1).strokeColor(BRAND.border).stroke()
  doc.moveDown(0.5)
  // restore default font
  doc.font('Helvetica')
}

function drawTable(doc, columns, rows, widths, options = {}) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const usableWidth = right - left
  const colWidths = widths && widths.length ? widths : new Array(columns.length).fill(usableWidth / columns.length)
  const padX = 6
  const padY = 4 // tighter vertical padding for Letter
  const colAligns = Array.isArray(options.align) ? options.align : []
  const headerAligns = Array.isArray(options.headerAlign) ? options.headerAlign : []

  const drawHeaderBand = () => {
    const y0 = doc.y
  const headerHeight = 20
    doc.save()
    // Cabecera estilo plataforma: banda ámbar + texto claro
    doc.rect(left, y0, usableWidth, headerHeight).fill(BRAND.accent)
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
    let x = left
    columns.forEach((c, idx) => {
      const label = typeof c === 'string' ? c : (c.text || '')
      const hAlign = headerAligns[idx] || (typeof c === 'object' && c.align) || 'left'
      doc.text(label, x + padX, y0 + (headerHeight - 12) / 2, { width: colWidths[idx] - padX * 2, align: hAlign })
      x += colWidths[idx]
    })
    doc.restore()
    doc.moveTo(left, y0 + headerHeight).lineTo(right, y0 + headerHeight).strokeColor(BRAND.border).lineWidth(1).stroke()
    doc.y = y0 + headerHeight + 2
  }

  // initial header
  drawHeaderBand()

  // rows with dynamic height and page breaks
  doc.fontSize(8).fillColor('#111') // slightly smaller for print fit
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx]
    // compute row height based on tallest cell
    const heights = row.map((cell, cIdx) => {
      const text = String(cell)
  const h = doc.heightOfString(text, { width: colWidths[cIdx] - padX * 2, align: isNumeric(text) ? 'right' : 'left' })
  return Math.max(13, h + padY)
    })
    const rowHeight = Math.max(...heights)
    // page break if needed
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      addPageWithBand(doc)
      drawHeaderBand()
    }
    // Y fija por fila: PDFKit mueve doc.y tras cada text(); si reutilizáramos doc.y por celda, los datos quedan escalonados.
    const rowTop = doc.y
    // zebra background
    if (rIdx % 2 === 1) {
      doc.save(); doc.rect(left, rowTop - 1, usableWidth, rowHeight + 2).fill('#fafafa'); doc.restore()
    }
    // draw text cells (misma línea base vertical para todas las columnas)
    let rx = left
    row.forEach((cell, cIdx) => {
      const text = String(cell)
      const forcedAlign = colAligns[cIdx]
      const align = forcedAlign || (isNumeric(text) ? 'right' : 'left')
      doc.fillColor('#111').text(text, rx + padX, rowTop + padY / 2, { width: colWidths[cIdx] - padX * 2, align })
      rx += colWidths[cIdx]
    })
    // row divider
    const yAfter = rowTop + rowHeight
    doc.moveTo(left, yAfter).lineTo(right, yAfter).strokeColor('#f3f4f6').lineWidth(1).stroke()
    doc.y = yAfter + 1
  }
  doc.moveDown(0.4)
}

function isNumeric(text) {
  if (typeof text === 'number') return true
  const s = String(text).trim()
  return /^\d+[\d\s\.,]*%?$/.test(s) || /^Q\s*\d[\d\s\.,]*$/.test(s)
}

// Summary cards helper (3-in-row when possible)
function drawSummaryCards(doc, cards) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const pageWidth = right - left
  const gap = 12
  const perRow = Math.min(3, Math.max(1, cards.length))
  const cardW = (pageWidth - gap * (perRow - 1)) / perRow
  const cardH = 48 // reduced height for Letter
  // Check available space for the entire block (rows of cards)
  const rows = Math.ceil(cards.length / perRow)
  const needed = rows * cardH + (rows - 1) * gap + 12
  ensureSpace(doc, needed)
  let x = left
  let y = doc.y
  const drawOne = (cx, cy, title, value) => {
    doc.save()
    doc.roundedRect(cx, cy, cardW, cardH, 8).fill('#ffffff').stroke(BRAND.border)
    doc.fillColor(BRAND.primary).fontSize(9).text(title, cx + 10, cy + 8, { width: cardW - 20 })
    doc.fillColor(BRAND.primary).fontSize(13).text(value, cx + 10, cy + 26, { width: cardW - 20 })
    doc.restore()
  }
  cards.forEach((c, idx) => {
    drawOne(x, y, c.label, c.value)
    if ((idx + 1) % perRow === 0 && idx < cards.length - 1) {
      x = left
      y += cardH + gap
    } else {
      x += cardW + gap
    }
  })
  doc.y = y + cardH + 12
}

// Suppliers grid: grouped by initial letter, cards in two columns for clarity
function drawSuppliersGrid(doc, suppliers) {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const usableWidth = right - left
  const gap = 12
  const colCount = 2
  const cardW = (usableWidth - gap * (colCount - 1)) / colCount
  const baseCardH = 58
  const pad = 10

  // group suppliers by first letter
  const groups = new Map()
  suppliers.forEach(s => {
    const letter = (s.name || '').trim().charAt(0).toUpperCase() || '#'
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter).push(s)
  })
  const sortedLetters = Array.from(groups.keys()).sort()

  const newPageWithHeader = () => {
    addPageWithBand(doc)
    sectionTitle(doc, 'Listado de Proveedores')
  }

  sortedLetters.forEach(letter => {
    // letter header band
    const yNeededForHeader = 26
    if (doc.y + yNeededForHeader > doc.page.height - doc.page.margins.bottom) newPageWithHeader()
    doc.save()
    doc.rect(left, doc.y, usableWidth, 20).fill(BRAND.accent)
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
      .text(letter, left + pad, doc.y + 4)
    doc.restore()
    doc.y += 24

    let x = left
    let yRowTop = doc.y
    let colIndex = 0
    let rowMaxH = 0
    const bottom = doc.page.height - doc.page.margins.bottom

    const measureHeights = (s) => {
      // compute dynamic height using real text wrapping
      const contentWidth = cardW - pad * 2
      // name height
      doc.font('Helvetica-Bold').fontSize(10)
      const nameH = doc.heightOfString(s.name || 'Proveedor', { width: contentWidth })
      // info lines
      doc.font('Helvetica').fontSize(8)
      const contactText = 'Contacto: ' + (s.contact || '—')
      const phoneText = 'Teléfono: ' + (s.phone || '—')
      const emailText = 'Correo: ' + (s.email || '—')
      const contactH = doc.heightOfString(contactText, { width: contentWidth })
      const phoneH = doc.heightOfString(phoneText, { width: contentWidth })
      const emailH = doc.heightOfString(emailText, { width: contentWidth })
      doc.font('Helvetica').fontSize(7)
      const metricsH = s.metricsLine
        ? doc.heightOfString(s.metricsLine, { width: contentWidth }) + 2
        : 0
      const inner = nameH + 6 + contactH + 2 + phoneH + 2 + emailH + metricsH
      return Math.max(baseCardH, 8 + inner + 8)
    }

    groups.get(letter).forEach((s, idx) => {
      const cardH = measureHeights(s)
      // Check if current row (with this card) fits; if not, new page & header again
      const projectedRowH = Math.max(rowMaxH || 0, cardH)
      if (yRowTop + projectedRowH > bottom) {
        newPageWithHeader()
        // letter header on new page
        doc.save(); doc.rect(left, doc.y, usableWidth, 20).fill(BRAND.accent); doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(letter, left + pad, doc.y + 4); doc.restore(); doc.y += 24
        x = left; yRowTop = doc.y; colIndex = 0; rowMaxH = 0
      }
      // background + border
      doc.save()
      doc.roundedRect(x, yRowTop, cardW, cardH, 6).fill('#ffffff').stroke('#e2e8f0')
      if (idx % 2 === 1) { doc.save(); doc.rect(x, yRowTop, cardW, cardH).fillOpacity(0.03).fill(BRAND.secondary); doc.restore() }
      doc.restore()
      // content
      const nameY = yRowTop + 8
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.primary)
        .text(s.name || 'Proveedor', x + pad, nameY, { width: cardW - pad * 2 })
      doc.font('Helvetica').fontSize(8).fillColor('#111')
      const infoStart = nameY + doc.heightOfString(s.name || 'Proveedor', { width: cardW - pad * 2 }) + 6
      const contactText = 'Contacto: ' + (s.contact || '—')
      const phoneText = 'Teléfono: ' + (s.phone || '—')
      const emailText = 'Correo: ' + (s.email || '—')
      let lineY = infoStart
      doc.text(contactText, x + pad, lineY, { width: cardW - pad * 2 })
      lineY += doc.heightOfString(contactText, { width: cardW - pad * 2 }) + 2
      doc.text(phoneText, x + pad, lineY, { width: cardW - pad * 2 })
      lineY += doc.heightOfString(phoneText, { width: cardW - pad * 2 }) + 2
      doc.text(emailText, x + pad, lineY, { width: cardW - pad * 2 })
      if (s.metricsLine) {
        lineY += doc.heightOfString(emailText, { width: cardW - pad * 2 }) + 2
        doc.font('Helvetica').fontSize(7).fillColor(BRAND.muted)
        doc.text(s.metricsLine, x + pad, lineY, { width: cardW - pad * 2 })
      }

      // track tallest card in this row
      rowMaxH = Math.max(rowMaxH, cardH)

      // advance column / row
      colIndex++
      if (colIndex === colCount) {
        colIndex = 0
        x = left
        yRowTop += rowMaxH + gap
        rowMaxH = 0
      } else {
        x += cardW + gap
      }
      // update global y to current row top
      doc.y = yRowTop
    })
    // If last row had a single column, advance by its height
    if (colIndex === 1) {
      yRowTop += rowMaxH + gap
      doc.y = yRowTop
    }
    doc.moveDown(0.6)
  })
}

async function getSalesData(startUtc, endUtc, req) {
  const status = await prisma.saleStatus.findFirst({ where: { name: 'Completada' } })
  const tenantSales = branchWhere(req)

  // Obtener sale_items (productos / categorías / costos)
  const items = await prisma.saleItem.findMany({
    where: { sale: { ...tenantSales, date: { gte: startUtc, lte: endUtc }, ...(status ? { status_id: status.id } : {}) } },
    include: {
      product: { include: { category: true } },
      sale: {
        select: {
          id: true,
          date: true,
          total: true,
          total_returned: true,
          payment_method: { select: { name: true } },
          createdBy: { select: { name: true } }
        }
      }
    }
  })

  // También obtener ventas a nivel cabecera para conteos rápidos
  const sales = await prisma.sale.findMany({
    where: {
      ...tenantSales,
      date: { gte: startUtc, lte: endUtc },
      ...(status ? { status_id: status.id } : {})
    },
    select: {
      id: true,
      branch_id: true,
      date: true,
      total: true,
      total_returned: true,
      adjusted_total: true,
      payment_method: { select: { name: true } },
      createdBy: { select: { name: true } }
    }
  })

  let totalRevenueGross = 0
  let totalReturned = 0
  let totalCost = 0

  // Agregados
  const catAgg = {}
  const topAgg = {}
  const paymentAgg = {}
  const timeAgg = {}   // key: 'YYYY-MM-DD' o 'YYYY-MM'
  const cashierAgg = {}
  const branchAgg = new Map() // solo se usa en consolidado
  // Para agregar ingresos por cabecera (una vez por venta) pero unidades desde sale_items
  const unitsBySaleId = new Map()

  // Helper: clave temporal (día o mes) según rango
  const rangeDays = (endUtc.getTime() - startUtc.getTime()) / (1000 * 60 * 60 * 24)
  const useDaily = rangeDays <= 62 // ~2 meses → por día, si no por mes

  const makeTimeKey = (d) => {
    const dt = DateTime.fromJSDate(d).setZone('America/Guatemala')
    if (useDaily) {
      return dt.toFormat('yyyy-LL-dd')
    }
    return dt.toFormat('yyyy-LL')
  }

  const getPaymentKey = (pm) => (pm?.name ? String(pm.name) : 'Sin método')
  const getCashierKey = (cb) => (cb?.name ? String(cb.name) : 'Sin asignar')

  // Procesar items: productos / categorías / costos / top productos.
  // Para método/tiempo/cajero solo acumulamos UNIDADES por venta (no el ingreso).
  items.forEach(i => {
    const qty = number(i.qty)
    const revenue = number(i.price) * qty
    const cost = number(i.product?.cost) * qty
    totalCost += cost

    const cat = i.product?.category?.name || 'Sin categoría'
    catAgg[cat] = (catAgg[cat] || 0) + revenue

    const pname = i.product?.name || 'Producto'
    topAgg[pname] = (topAgg[pname] || { name: pname, ventas: 0, revenue: 0 })
    topAgg[pname].ventas += qty
    topAgg[pname].revenue += revenue
    const sale = i.sale
    if (sale?.id) {
      unitsBySaleId.set(String(sale.id), (unitsBySaleId.get(String(sale.id)) || 0) + qty)
    }
  })

  // Agregados de ingreso y conteos UNA VEZ por venta (cabecera)
  sales.forEach(sale => {
    totalRevenueGross += number(sale.total)
    totalReturned += number(sale.total_returned)
    const adjusted = number(sale.adjusted_total ?? (number(sale.total) - number(sale.total_returned || 0)))

    const pmKey = getPaymentKey(sale.payment_method)
    const cashKey = getCashierKey(sale.createdBy)
    const tKey = makeTimeKey(sale.date)
    const units = unitsBySaleId.get(String(sale.id)) || 0

    paymentAgg[pmKey] = paymentAgg[pmKey] || { method: pmKey, ventas: 0, unidades: 0, revenue: 0 }
    paymentAgg[pmKey].ventas += 1
    paymentAgg[pmKey].unidades += units
    paymentAgg[pmKey].revenue += adjusted

    cashierAgg[cashKey] = cashierAgg[cashKey] || { cajero: cashKey, ventas: 0, unidades: 0, revenue: 0 }
    cashierAgg[cashKey].ventas += 1
    cashierAgg[cashKey].unidades += units
    cashierAgg[cashKey].revenue += adjusted

    timeAgg[tKey] = timeAgg[tKey] || { periodo: tKey, ventas: 0, unidades: 0, revenue: 0 }
    timeAgg[tKey].ventas += 1
    timeAgg[tKey].unidades += units
    timeAgg[tKey].revenue += adjusted

    const bKey = String(sale.branch_id)
    const bAgg = branchAgg.get(bKey) || { ventas: 0, unidades: 0, revenue: 0 }
    bAgg.ventas += 1
    bAgg.unidades += units
    bAgg.revenue += adjusted
    branchAgg.set(bKey, bAgg)
  })

  const totalRevenue = totalRevenueGross - totalReturned

  const categories = Object.entries(catAgg).map(([category, revenue]) => ({
    category,
    revenue: Number(revenue.toFixed(2))
  }))

  const topProducts = Object.values(topAgg)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map(p => ({
      name: p.name,
      ventas: p.ventas,
      revenue: Number(p.revenue.toFixed(2))
    }))

  const salesByMethod = Object.values(paymentAgg).map(p => ({
    method: p.method,
    ventas: p.ventas,
    unidades: p.unidades,
    revenue: Number(p.revenue.toFixed(2))
  }))

  const salesByPeriod = Object.values(timeAgg)
    .sort((a, b) => a.periodo.localeCompare(b.periodo))
    .map(p => ({
      periodo: p.periodo,
      ventas: p.ventas,
      unidades: p.unidades,
      revenue: Number(p.revenue.toFixed(2))
    }))

  const salesByCashier = Object.values(cashierAgg).map(p => ({
    cajero: p.cajero,
    ventas: p.ventas,
    unidades: p.unidades,
    revenue: Number(p.revenue.toFixed(2))
  }))

  const tickets = sales.length
  const unidadesTotales = items.reduce((acc, i) => acc + number(i.qty), 0)
  const ticketPromedio = tickets > 0 ? totalRevenue / tickets : 0

  // En consolidado los totales suman varias sucursales: hay que poder ver cuál es cuál.
  let salesByBranch = []
  if (!req.branchId) {
    const scope = await reportScope(req)
    salesByBranch = scope.branches.map((b) => {
      const a = branchAgg.get(b.id) || { ventas: 0, unidades: 0, revenue: 0 }
      return { branch: b.name, ventas: a.ventas, unidades: a.unidades, revenue: Number(a.revenue.toFixed(2)) }
    })
  }

  return {
    salesByBranch,
    totalRevenue: Number(totalRevenue.toFixed(2)),              // Neto (con devoluciones)
    totalRevenueGross: Number(totalRevenueGross.toFixed(2)),    // Bruto (sin devoluciones)
    totalReturned: Number(totalReturned.toFixed(2)),            // Total devuelto
    totalCost: Number(totalCost.toFixed(2)),
    totalProfit: Number((totalRevenue - totalCost).toFixed(2)),
    tickets,
    unidadesTotales,
    ticketPromedio: Number(ticketPromedio.toFixed(2)),
    categories,
    topProducts,
    salesByMethod,
    salesByPeriod,
    salesByCashier,
    useDaily
  }
}

/**
 * Datos para reporte financiero: P&L del período + inventario a la fecha + compras registradas.
 * No sustituye al reporte de ventas (sin desglose operativo por cajero/método/top productos).
 */
async function getFinancialData(startUtc, endUtc, req) {
  const sales = await getSalesData(startUtc, endUtc, req)

  const products = await prisma.product.findMany({
    where: { deleted: false, deleted_at: null, company_id: req.companyId },
    select: { id: true, stock: true, cost: true }
  })
  await overlayReportBranchStock(products, req)
  let inventoryValue = 0
  let inventoryUnits = 0
  for (const p of products) {
    const st = number(p.stock)
    inventoryValue += st * number(p.cost)
    inventoryUnits += st
  }

  // Lo enviado y no recibido no está en ningún anaquel, así que no aparece
  // arriba, pero sigue siendo de la empresa: sin esta línea la valuación queda
  // corta y no cuadra contra la cuenta contable de Inventario. Acotado a un
  // almacén o ubicación no aplica: el tránsito no vive en ninguno.
  const { active: filtradoPorAlmacen } = warehouseFilter(req)
  const enTransito = filtradoPorAlmacen
    ? { units: 0, value: 0 }
    : await inTransitTotals(req.companyId, products, { branchIds: scopeBranchIds(req) })

  const purchaseLogs = await prisma.purchaseLog.findMany({
    where: { date: { gte: startUtc, lte: endUtc }, product: { company_id: req.companyId } },
    select: {
      qty: true,
      cost: true,
      source: true,
      supplier: { select: { name: true } }
    }
  })
  let purchasesTotal = 0
  let initialInventoryTotal = 0
  let initialInventoryUnits = 0
  let initialInventoryLines = 0
  const purchasesBySupplier = {}
  for (const pl of purchaseLogs) {
    const lineVal = number(pl.qty) * number(pl.cost)
    // El saldo de apertura no es una compra del período: se reporta aparte.
    if (pl.source === 'INITIAL') {
      initialInventoryTotal += lineVal
      initialInventoryUnits += number(pl.qty)
      initialInventoryLines += 1
      continue
    }
    purchasesTotal += lineVal
    const name = pl.supplier?.name || '—'
    if (!purchasesBySupplier[name]) {
      purchasesBySupplier[name] = { supplier: name, lines: 0, units: 0, amount: 0 }
    }
    purchasesBySupplier[name].lines += 1
    purchasesBySupplier[name].units += number(pl.qty)
    purchasesBySupplier[name].amount += lineVal
  }
  const purchasesBySupplierList = Object.values(purchasesBySupplier)
    .map((p) => ({
      supplier: p.supplier,
      lines: p.lines,
      units: p.units,
      amount: Number(p.amount.toFixed(2))
    }))
    .sort((a, b) => b.amount - a.amount)

  const status = await prisma.saleStatus.findFirst({ where: { name: 'Completada' } })
  const saleItems = await prisma.saleItem.findMany({
    where: {
      sale: {
        ...branchWhere(req),
        date: { gte: startUtc, lte: endUtc },
        ...(status ? { status_id: status.id } : {})
      }
    },
    include: { product: { include: { category: true } } }
  })
  const byCat = {}
  for (const i of saleItems) {
    const cat = i.product?.category?.name || 'Sin categoría'
    const rev = number(i.price) * number(i.qty)
    const c = number(i.product?.cost) * number(i.qty)
    if (!byCat[cat]) byCat[cat] = { revenue: 0, cost: 0 }
    byCat[cat].revenue += rev
    byCat[cat].cost += c
  }
  const categoryProfitability = Object.entries(byCat)
    .map(([category, v]) => {
      const revenue = Number(v.revenue.toFixed(2))
      const cost = Number(v.cost.toFixed(2))
      const profit = Number((v.revenue - v.cost).toFixed(2))
      const marginPct = v.revenue > 0 ? Number((((v.revenue - v.cost) / v.revenue) * 100).toFixed(1)) : 0
      return { category, revenue, cost, profit, marginPct }
    })
    .sort((a, b) => b.profit - a.profit)

  const cogs = sales.totalCost
  const grossMarginPct =
    sales.totalRevenue > 0
      ? Number(((sales.totalProfit / sales.totalRevenue) * 100).toFixed(1))
      : 0

  const inventoryTurnover =
    inventoryValue > 0 && cogs > 0 ? Number((cogs / inventoryValue).toFixed(2)) : null

  const daysInPeriod = Math.max(
    1,
    (endUtc.getTime() - startUtc.getTime()) / (1000 * 60 * 60 * 24)
  )
  const daysOfInventoryApprox =
    cogs > 0 && inventoryValue > 0
      ? Number(((inventoryValue / cogs) * daysInPeriod).toFixed(1))
      : null

  return {
    ...sales,
    inventoryValue: Number(inventoryValue.toFixed(2)),
    inventoryUnits,
    inventorySkuCount: products.length,
    inTransitUnits: enTransito.units,
    inTransitValue: Number(enTransito.value.toFixed(2)),
    // Lo que la empresa posee: anaqueles + camioneta. Es la cifra que se compara
    // contra la cuenta contable de Inventario.
    inventoryValueOwned: Number((inventoryValue + enTransito.value).toFixed(2)),
    purchasesPeriod: Number(purchasesTotal.toFixed(2)),
    purchaseLogLines: purchaseLogs.length - initialInventoryLines,
    purchasesBySupplier: purchasesBySupplierList,
    initialInventoryPeriod: Number(initialInventoryTotal.toFixed(2)),
    initialInventoryUnitsPeriod: initialInventoryUnits,
    initialInventoryLines,
    categoryProfitability,
    grossMarginPct,
    inventoryTurnover,
    daysOfInventoryApprox
  }
}

/** Agrega por proveedor: conteo de SKUs activos, unidades en stock y valor de inventario (stock × costo). */
async function getSuppliersReportData(req) {
  const suppliers = await prisma.supplier.findMany({
    where: { deleted: false, party_type: 'SUPPLIER', company_id: req.companyId },
    include: {
      supplier_payment_terms: {
        include: { payment_term: true },
        orderBy: { sort_order: 'asc' },
      },
    },
    orderBy: { name: 'asc' }
  })

  const productRows = await prisma.product.findMany({
    where: { deleted: false, deleted_at: null, company_id: req.companyId },
    select: { id: true, supplier_id: true, stock: true, cost: true }
  })
  await overlayReportBranchStock(productRows, req)

  const aggBySupplier = new Map()
  for (const p of productRows) {
    const prev = aggBySupplier.get(p.supplier_id) || { productCount: 0, stockUnits: 0, inventoryValue: 0 }
    prev.productCount += 1
    const st = number(p.stock)
    const cst = number(p.cost)
    prev.stockUnits += st
    prev.inventoryValue += st * cst
    aggBySupplier.set(p.supplier_id, prev)
  }

  const enriched = suppliers.map((s) => {
    const a = aggBySupplier.get(s.id) || { productCount: 0, stockUnits: 0, inventoryValue: 0 }
    const links = Array.isArray(s.supplier_payment_terms) ? s.supplier_payment_terms : []
    const names = links
      .map((l) => l.payment_term?.name)
      .filter(Boolean)
    const def = links.find((l) => l.is_default) || links[0]
    return {
      ...s,
      productCount: a.productCount,
      stockUnits: a.stockUnits,
      inventoryValue: a.inventoryValue,
      paymentTermName: names.length ? names.join(', ') : (def?.payment_term?.name || '—')
    }
  })

  const totalInventoryValue = enriched.reduce((sum, s) => sum + s.inventoryValue, 0)

  return {
    suppliers: enriched,
    summary: {
      totalSuppliers: enriched.length,
      activeSuppliers: enriched.filter((s) => s.estado === 1).length,
      withPhone: enriched.filter((s) => s.phone && String(s.phone).trim()).length,
      withEmail: enriched.filter((s) => s.email && String(s.email).trim()).length,
      withoutProducts: enriched.filter((s) => s.productCount === 0).length,
      totalProductSkus: productRows.length,
      totalInventoryValue
    }
  }
}

/** Escapado RFC 4180 para celdas CSV (comas, comillas, saltos de línea). */
function csvEscape(val) {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function csvRow(cells) {
  if (!Array.isArray(cells)) return csvEscape(cells)
  return cells.map((c) => csvEscape(c)).join(',')
}

/** Línea de metadatos: si hay coma, primera coma separa clave y valor (el valor puede llevar más comas). */
function csvHeaderMetadataLine(line) {
  const s = String(line)
  const i = s.indexOf(',')
  if (i === -1) return csvRow([s])
  return csvRow([s.slice(0, i).trim(), s.slice(i + 1)])
}

/**
 * CSV con secciones legibles: BOM UTF-8 (Excel), bloque cabecera, separadores ▸ por tabla.
 * @param {string[]} headerLines - Título(s) sin coma, o pares Concepto,Valor con primera coma como separador
 * @param {{ title?: string, columns: string[], rows: (string|number)[][] }[]} sections
 */
function sendCsv(res, filename, headerLines = [], sections = []) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`)
  const lines = []
  lines.push(csvRow([`Archivo: ${filename}.csv`]))
  lines.push(csvRow(['Formato', 'CSV separado por comas, codificación UTF-8 (BOM). Cada bloque de tabla lleva título en la columna A.']))
  lines.push('')
  if (headerLines.length) {
    lines.push(csvRow(['── Resumen del reporte (metadatos y totales) ──']))
  }
  for (const h of headerLines) {
    lines.push(csvHeaderMetadataLine(h))
  }

  sections.forEach((sec, secIdx) => {
    if (!sec || !sec.rows || !sec.columns) return
    lines.push('')
    lines.push(csvRow([`── ${sec.title || `Sección ${secIdx + 1}`} ──`]))
    lines.push(csvRow(sec.columns))
    for (const r of sec.rows) {
      const row = Array.isArray(r) ? r : [r]
      while (row.length < sec.columns.length) row.push('')
      lines.push(csvRow(row.slice(0, sec.columns.length)))
    }
  })

  lines.push('')
  lines.push(csvRow(['Fin del reporte', DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')]))

  const body = lines.join('\r\n')
  res.send(`\ufeff${body}`)
}

async function salesReport(req, res, next) {
  try {
  const branding = await getBrandingForPdf(prisma, req.companyId)
  const companyName = branding.company_name
  const logoBuffer = branding.logoBuffer
  const money = makeMoney(branding.currency_code)
  const { period='month', year, format='pdf', month, quarter, semester } = req.query
  const { startUtc, endUtc, label } = periodRange(period, year, { month, quarter, semester })
    const data = await getSalesData(startUtc, endUtc, req)
    const scope = await reportScope(req)
    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      const total = data.totalRevenueGross || 1
      sendCsv(res, 'reporte-ventas', [
        'REPORTE DE VENTAS',
        `Periodo,${label}`,
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}`,
        `Ventas Brutas,${money(data.totalRevenueGross)}`,
        `Devoluciones,${money(data.totalReturned)}`,
        `Ventas Netas,${money(data.totalRevenue)}`,
        `Costos Totales,${money(data.totalCost)}`,
        `Ganancia Neta,${money(data.totalProfit)}`,
        `Tickets,${data.tickets}`,
        `Unidades Vendidas,${data.unidadesTotales}`,
        `Ticket Promedio,${money(data.ticketPromedio)}`
      ], [
        ...(data.salesByBranch.length ? [{
          title: 'Ventas por Sucursal',
          columns: ['Sucursal','Tickets','Unidades','Ingresos'],
          rows: data.salesByBranch.map(b => [b.branch, b.ventas, b.unidades, money(b.revenue)])
        }] : []),
        { title: 'Top Productos', columns: ['Producto','Unidades','Ingresos'], rows: data.topProducts.map(p=>[p.name, p.ventas, money(p.revenue)]) },
        { title: 'Categorias', columns: ['Categoría','Ingresos','%'], rows: data.categories.map(c=>[c.category, money(c.revenue), Math.round((c.revenue/total)*100)+'%']) },
        {
          title: 'Ventas por Método de Pago',
          columns: ['Método','Tickets','Unidades','Ingresos'],
          rows: data.salesByMethod.map(m => [m.method, m.ventas, m.unidades, money(m.revenue)])
        },
        {
          title: data.useDaily ? 'Ventas por Día' : 'Ventas por Mes',
          columns: [data.useDaily ? 'Fecha' : 'Mes','Tickets','Unidades','Ingresos'],
          rows: data.salesByPeriod.map(p => [p.periodo, p.ventas, p.unidades, money(p.revenue)])
        },
        {
          title: 'Ventas por Cajero',
          columns: ['Cajero','Tickets','Unidades','Ingresos'],
          rows: data.salesByCashier.map(c => [c.cajero, c.ventas, c.unidades, money(c.revenue)])
        }
      ])
      return
    }
    const doc = newDoc(res, 'Reporte de Ventas')
    header(doc, 'Reporte de Ventas', label, companyName, logoBuffer, scope.label)
    sectionTitle(doc, 'Resumen')
    drawSummaryCards(doc, [
      { label: 'Ventas Brutas', value: money(data.totalRevenueGross) },
      { label: 'Devoluciones', value: money(data.totalReturned) },
      { label: 'Ventas Netas', value: money(data.totalRevenue) },
      { label: 'Costos Totales', value: money(data.totalCost) },
      { label: 'Ganancia Neta', value: money(data.totalProfit) },
      { label: 'Tickets', value: String(data.tickets) },
      { label: 'Unidades Vendidas', value: String(data.unidadesTotales) },
      { label: 'Ticket Promedio', value: money(data.ticketPromedio) },
    ])
    if (data.salesByBranch.length) {
      sectionTitle(doc, 'Ventas por sucursal')
      drawTable(
        doc,
        ['Sucursal','Tickets','Unidades','Ingresos'],
        data.salesByBranch.map(b => [b.branch, b.ventas, b.unidades, money(b.revenue)]),
        [150,60,60,80],
        { align: ['left','right','right','right'], headerAlign: ['left','right','right','right'] }
      )
    }

    sectionTitle(doc, 'Top Productos (por ingresos)')
    drawTable(
      doc,
      ['Producto','Unidades','Ingresos'],
      data.topProducts.map(p=>[p.name, p.ventas, money(p.revenue)]),
      [150,80,100],
      { align: ['left','right','right'], headerAlign: ['left','right','right'] }
    )

    sectionTitle(doc, 'Categorías (por ingresos)')
    {
      const total = data.totalRevenue || 1
      drawTable(
        doc,
        ['Categoría','Ingresos','%'],
        data.categories.map(c=>[c.category, money(c.revenue), Math.round((c.revenue/total)*100)+'%']),
        [150,120,50],
        { align: ['left','right','right'], headerAlign: ['left','right','right'] }
      )
    }

    sectionTitle(doc, 'Ventas por método de pago')
    drawTable(
      doc,
      ['Método','Tickets','Unidades','Ingresos'],
      data.salesByMethod.map(m => [m.method, m.ventas, m.unidades, money(m.revenue)]),
      [130,60,60,80],
      { align: ['left','right','right','right'], headerAlign: ['left','right','right','right'] }
    )

    sectionTitle(doc, data.useDaily ? 'Ventas por día' : 'Ventas por mes')
    drawTable(
      doc,
      [data.useDaily ? 'Fecha' : 'Mes','Tickets','Unidades','Ingresos'],
      data.salesByPeriod.map(p => [p.periodo, p.ventas, p.unidades, money(p.revenue)]),
      [120,60,60,80],
      { align: ['left','right','right','right'], headerAlign: ['left','right','right','right'] }
    )

    sectionTitle(doc, 'Ventas por cajero')
    drawTable(
      doc,
      ['Cajero','Tickets','Unidades','Ingresos'],
      data.salesByCashier.map(c => [c.cajero, c.ventas, c.unidades, money(c.revenue)]),
      [130,60,60,80],
      { align: ['left','right','right','right'], headerAlign: ['left','right','right','right'] }
    )
    footer(doc, companyName)
    doc.end()
  } catch(e) { next(e) }
}

async function inventoryReport(req,res,next){
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const { format='pdf' } = req.query
    // Solo lo que se maneja en el alcance: el catálogo es de la empresa, pero el
    // reporte de inventario es de sucursal(es) y no debe listar productos ajenos.
    const products = await prisma.product.findMany({
      where: {
        deleted_at: null,
        company_id: req.companyId,
        branch_stocks: { some: { branch_id: { in: scopeBranchIds(req) } } },
      },
      include:{ category:true },
    })
    await overlayReportBranchStock(products, req)
    const scope = await reportScope(req)
    const byBranch = await stockByBranch(req, scope)
    const byWarehouse = await stockByWarehouse(req)
    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      const totalValue = products.reduce((acc,p)=>acc+ number(p.stock)* number(p.cost),0)
      sendCsv(res, 'reporte-inventario', [
        'REPORTE DE INVENTARIO',
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}`,
        `Total Productos,${products.length}`,
        `Valor Total,${money(totalValue)}`
      ], [
        ...(byBranch.length ? [{
          title:'Inventario por Sucursal',
          columns:['Sucursal','SKUs','Unidades','Valor'],
          rows: byBranch.map(b=>[b.branch, b.skus, b.units, money(b.value)])
        }] : []),
        ...(byWarehouse.length ? [{
          title:'Inventario por Almacén',
          columns:['Almacén','SKUs','Unidades','Valor'],
          rows: byWarehouse.map(w=>[w.warehouse, w.skus, w.units, money(w.value)])
        }] : []),
        {
          title:'Detalle',
          columns:['Producto','Categoría','Stock','Costo','Valor'],
          rows: products.map(p=>[p.name, p.category?.name||'—', p.stock, money(number(p.cost)), money(number(p.stock)*number(p.cost))])
        }
      ])
      return
    }
    const doc = newDoc(res, 'Reporte de Inventario')
    header(doc, 'Reporte de Inventario', 'Actual', companyName, logoBuffer, scope.label)
    sectionTitle(doc, 'Resumen')
    const totalProducts = products.length
    const totalValue = products.reduce((acc,p)=>acc+ number(p.stock)* number(p.cost),0)
    const lowStock = products.filter(p=> number(p.stock) <= number(p.min_stock)).length
    drawSummaryCards(doc, [
      { label: 'Productos Totales', value: String(totalProducts) },
      { label: 'Valor Inventario', value: money(totalValue) },
      { label: 'Stock Bajo', value: String(lowStock) },
    ])
  if (byBranch.length) {
    sectionTitle(doc, 'Inventario por sucursal')
    drawTable(
      doc,
      ['Sucursal','SKUs','Unidades','Valor'],
      byBranch.map(b=>[b.branch, b.skus, b.units, money(b.value)]),
      [170,70,70,90],
      { align: ['left','right','right','right'], headerAlign: ['left','right','right','right'] }
    )
  }
  if (byWarehouse.length) {
    sectionTitle(doc, 'Inventario por almacén')
    drawTable(
      doc,
      ['Almacén','SKUs','Unidades','Valor'],
      byWarehouse.map(w=>[w.warehouse, w.skus, w.units, money(w.value)]),
      [170,70,70,90],
      { align: ['left','right','right','right'], headerAlign: ['left','right','right','right'] }
    )
  }
  sectionTitle(doc,'Detalle de Inventario')
  drawTable(doc, ['Producto','Categoría','Stock','Costo','Valor'], products.slice(0,100).map(p=>[p.name, p.category?.name||'—', p.stock, money(number(p.cost)), money(number(p.stock)*number(p.cost))]), [170,110,50,70,80], { align: ['left','left','right','right','right'], headerAlign: ['left','left','right','right','right'] })
    footer(doc, companyName)
    doc.end()
  } catch(e){ next(e) }
}

async function suppliersReport(req, res, next) {
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const { format = 'pdf' } = req.query
    const data = await getSuppliersReportData(req)
    const { suppliers, summary } = data
    const scope = await reportScope(req)
    const fmtLast = (d) =>
      d ? DateTime.fromJSDate(d).setZone('America/Guatemala').toFormat('yyyy-LL-dd') : '—'

    const topByInv = [...suppliers]
      .filter((s) => s.inventoryValue > 0)
      .sort((a, b) => b.inventoryValue - a.inventoryValue)
      .slice(0, 15)

    const sinProdRows = suppliers
      .filter((s) => s.productCount === 0)
      .map((s) => [s.name, s.contact || '—', s.phone || '—'])

    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      const sections = [
        {
          title: 'Top por valor de inventario',
          columns: ['Proveedor', '# Productos', 'Unidades stock', 'Valor inventario'],
          rows: topByInv.map((s) => [s.name, s.productCount, s.stockUnits, money(s.inventoryValue)])
        },
        {
          title: 'Resumen por proveedor',
          columns: [
            'Nombre',
            'Contacto',
            'Teléfono',
            'Correo',
            'Plazo pago',
            '# Productos',
            'Unidades',
            'Valor inventario',
            'Compras acum.',
            'Última orden',
            'Estado'
          ],
          rows: suppliers.map((s) => [
            s.name,
            s.contact || '—',
            s.phone || '—',
            s.email || '—',
            s.paymentTermName,
            s.productCount,
            s.stockUnits,
            money(s.inventoryValue),
            money(number(s.total_purchases)),
            fmtLast(s.last_order),
            s.estado === 1 ? 'Activo' : 'Inactivo'
          ])
        }
      ]
      if (sinProdRows.length) {
        sections.push({
          title: 'Proveedores sin productos vinculados',
          columns: ['Nombre', 'Contacto', 'Teléfono'],
          rows: sinProdRows
        })
      }
      sendCsv(res, 'reporte-proveedores', [
        'REPORTE DE PROVEEDORES',
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}`,
        `Total proveedores,${summary.totalSuppliers}`,
        `Activos,${summary.activeSuppliers}`,
        `Con teléfono,${summary.withPhone}`,
        `Con correo,${summary.withEmail}`,
        `SKUs en catálogo (vinculados),${summary.totalProductSkus}`,
        `Valor total inventario,${money(summary.totalInventoryValue)}`,
        `Proveedores sin productos,${summary.withoutProducts}`
      ], sections)
      return
    }

    const doc = newDoc(res, 'Reporte de Proveedores')
    header(doc, 'Reporte de Proveedores', 'Actual', companyName, logoBuffer, scope.label)
    sectionTitle(doc, 'Resumen')
    drawSummaryCards(doc, [
      { label: 'Total proveedores', value: String(summary.totalSuppliers) },
      { label: 'Activos', value: String(summary.activeSuppliers) },
      { label: 'SKUs vinculados', value: String(summary.totalProductSkus) },
      { label: 'Valor inventario', value: money(summary.totalInventoryValue) },
      { label: 'Sin productos', value: String(summary.withoutProducts) },
      { label: 'Con teléfono', value: String(summary.withPhone) }
    ])
    sectionTitle(doc, 'Top por valor de inventario')
    drawTable(
      doc,
      ['Proveedor', '# Prod.', 'Unid. stock', 'Valor inv.'],
      topByInv.map((s) => [s.name, s.productCount, s.stockUnits, money(s.inventoryValue)]),
      [175, 52, 58, 95],
      { align: ['left', 'right', 'right', 'right'], headerAlign: ['left', 'right', 'right', 'right'] }
    )
    if (!topByInv.length) {
      ensureSpace(doc, 24)
      doc.fontSize(9).fillColor(BRAND.muted).text('Sin datos de inventario valorizado (stock * costo).', doc.page.margins.left)
      doc.moveDown(0.5)
    }

    sectionTitle(doc, 'Resumen por proveedor')
    drawTable(
      doc,
      ['Nombre', 'Plazo', 'Prod.', 'Unid.', 'Valor inv.', 'Compras', 'Últ. orden', 'Tel.'],
      suppliers.map((s) => [
        s.name,
        s.paymentTermName,
        s.productCount,
        s.stockUnits,
        money(s.inventoryValue),
        money(number(s.total_purchases)),
        fmtLast(s.last_order),
        s.phone || '—'
      ]),
      [118, 62, 34, 36, 68, 68, 62, 78],
      {
        align: ['left', 'left', 'right', 'right', 'right', 'right', 'left', 'left'],
        headerAlign: ['left', 'left', 'right', 'right', 'right', 'right', 'left', 'left']
      }
    )

    if (sinProdRows.length) {
      sectionTitle(doc, 'Proveedores sin productos vinculados')
      drawTable(doc, ['Nombre', 'Contacto', 'Teléfono'], sinProdRows, [200, 160, 140], {
        align: ['left', 'left', 'left'],
        headerAlign: ['left', 'left', 'left']
      })
    }

    sectionTitle(doc, 'Listado visual por letra')
    const forGrid = suppliers.slice(0, 300).map((s) => ({
      name: s.name,
      contact: s.contact,
      phone: s.phone,
      email: s.email,
      metricsLine: `Productos: ${s.productCount} | Unid.: ${s.stockUnits} | Inv.: ${money(s.inventoryValue)}`
    }))
    drawSuppliersGrid(doc, forGrid)

    footer(doc, companyName)
    doc.end()
  } catch (e) {
    next(e)
  }
}

async function financialReport(req, res, next) {
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const { period = 'month', year, format = 'pdf', month, quarter, semester } = req.query
    const { startUtc, endUtc, label } = periodRange(period, year, { month, quarter, semester })
    const data = await getFinancialData(startUtc, endUtc, req)
    const scope = await reportScope(req)
    const byBranch = await stockByBranch(req, scope)
    const byWarehouse = await stockByWarehouse(req)

    const rotTxt = data.inventoryTurnover != null ? String(data.inventoryTurnover) : '—'
    const dInvTxt = data.daysOfInventoryApprox != null ? String(data.daysOfInventoryApprox) : '—'

    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      sendCsv(res, 'reporte-financiero', [
        'REPORTE FINANCIERO',
        'Alcance,Resultados del período seleccionado e inventario a la fecha de generación',
        `Periodo,${label}`,
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}`,
        `Valor inventario (fecha generación),${money(data.inventoryValue)}`,
        `Unidades en stock,${data.inventoryUnits}`,
        `SKUs activos,${data.inventorySkuCount}`,
        ...(data.inTransitUnits > 0 ? [
          `En tránsito (enviado sin recibir),${money(data.inTransitValue)}`,
          `Unidades en tránsito,${data.inTransitUnits}`,
          `Valor total propiedad de la empresa,${money(data.inventoryValueOwned)}`,
        ] : []),
        `Compras registradas período,${money(data.purchasesPeriod)}`,
        `Líneas de compra (movimientos),${data.purchaseLogLines}`,
        `Ingresos brutos ventas,${money(data.totalRevenueGross)}`,
        `Devoluciones,${money(data.totalReturned)}`,
        `Ingresos netos,${money(data.totalRevenue)}`,
        `CMV (costo mercancía vendida),${money(data.totalCost)}`,
        `Margen bruto,${money(data.totalProfit)}`,
        `Margen bruto %,${data.grossMarginPct}%`,
        `Rotación inventario (CMV / valor inv.),${rotTxt}`,
        `Días aprox. de inventario,${dInvTxt}`
      ], [
        ...(data.salesByBranch.length ? [{
          title: 'Ventas por Sucursal (período)',
          columns: ['Sucursal', 'Tickets', 'Unidades', 'Ingresos'],
          rows: data.salesByBranch.map((b) => [b.branch, b.ventas, b.unidades, money(b.revenue)])
        }] : []),
        ...(byBranch.length ? [{
          title: 'Inventario por Sucursal',
          columns: ['Sucursal', 'SKUs', 'Unidades', 'Valor'],
          rows: byBranch.map((b) => [b.branch, b.skus, b.units, money(b.value)])
        }] : []),
        ...(byWarehouse.length ? [{
          title: 'Valor de Inventario por Almacén',
          columns: ['Almacén', 'SKUs', 'Unidades', 'Valor'],
          rows: byWarehouse.map((w) => [w.warehouse, w.skus, w.units, money(w.value)])
        }] : []),
        {
          title: 'Estado de resultado (período)',
          columns: ['Concepto', 'Monto'],
          rows: [
            ['Ingresos brutos por ventas', money(data.totalRevenueGross)],
            ['(-) Devoluciones', money(data.totalReturned)],
            ['Ingresos netos', money(data.totalRevenue)],
            ['(-) Costo de mercancía vendida (CMV)', money(data.totalCost)],
            ['Margen bruto', money(data.totalProfit)]
          ]
        },
        {
          title: 'Rentabilidad por categoría',
          columns: ['Categoría', 'Ingresos', 'CMV', 'Margen', 'Margen %'],
          rows: data.categoryProfitability.map((c) => [
            c.category,
            money(c.revenue),
            money(c.cost),
            money(c.profit),
            `${c.marginPct}%`
          ])
        },
        {
          title: 'Compras por proveedor (período)',
          columns: ['Proveedor', 'Líneas', 'Unidades', 'Monto'],
          rows: data.purchasesBySupplier.map((p) => [p.supplier, p.lines, p.units, money(p.amount)])
        }
      ])
      return
    }

    const doc = newDoc(res, 'Reporte Financiero')
    header(doc, 'Reporte Financiero', label, companyName, logoBuffer, scope.label)

    sectionTitle(doc, 'Resumen - inventario, compras y margen')
    drawSummaryCards(doc, [
      { label: 'Valor inventario (hoy)', value: money(data.inventoryValue) },
      { label: 'Compras del período', value: money(data.purchasesPeriod) },
      { label: 'Ventas netas', value: money(data.totalRevenue) },
      { label: 'CMV (vendido)', value: money(data.totalCost) },
      { label: 'Margen bruto', value: money(data.totalProfit) },
      { label: 'Margen %', value: `${data.grossMarginPct}%` }
    ])

    ensureSpace(doc, 36)
    doc
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(
        `Stock: ${data.inventoryUnits} u. | SKUs: ${data.inventorySkuCount} | ` +
          (data.inTransitUnits > 0
            ? `En tránsito: ${data.inTransitUnits} u. (${money(data.inTransitValue)}) | ` +
              `Total propiedad de la empresa: ${money(data.inventoryValueOwned)} | `
            : '') +
          `Movimientos de compra: ${data.purchaseLogLines} | ` +
          `Rotación (CMV / valor inv.): ${rotTxt} | Días aprox. de inventario: ${dInvTxt}`,
        doc.page.margins.left,
        doc.y,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      )
    doc.moveDown(1.1)

    if (data.salesByBranch.length || byBranch.length) {
      sectionTitle(doc, 'Desglose por sucursal')
      if (data.salesByBranch.length) {
        drawTable(
          doc,
          ['Sucursal', 'Tickets', 'Unidades', 'Ingresos'],
          data.salesByBranch.map((b) => [b.branch, b.ventas, b.unidades, money(b.revenue)]),
          [170, 70, 70, 90],
          { align: ['left', 'right', 'right', 'right'], headerAlign: ['left', 'right', 'right', 'right'] }
        )
      }
      if (byBranch.length) {
        drawTable(
          doc,
          ['Sucursal', 'SKUs', 'Unidades stock', 'Valor inventario'],
          byBranch.map((b) => [b.branch, b.skus, b.units, money(b.value)]),
          [170, 70, 90, 100],
          { align: ['left', 'right', 'right', 'right'], headerAlign: ['left', 'right', 'right', 'right'] }
        )
      }
    }

    if (byWarehouse.length) {
      sectionTitle(doc, 'Valor de inventario por almacén')
      drawTable(
        doc,
        ['Almacén', 'SKUs', 'Unidades stock', 'Valor inventario'],
        byWarehouse.map((w) => [w.warehouse, w.skus, w.units, money(w.value)]),
        [170, 70, 90, 100],
        { align: ['left', 'right', 'right', 'right'], headerAlign: ['left', 'right', 'right', 'right'] }
      )
    }

    sectionTitle(doc, 'Estado de resultado del período')
    drawTable(
      doc,
      ['Concepto', 'Monto'],
      [
        ['Ingresos brutos por ventas', money(data.totalRevenueGross)],
        ['(-) Devoluciones', money(data.totalReturned)],
        ['Ingresos netos', money(data.totalRevenue)],
        ['(-) Costo de mercancía vendida (CMV)', money(data.totalCost)],
        ['Margen bruto', money(data.totalProfit)]
      ],
      [350, 120],
      { align: ['left', 'right'], headerAlign: ['left', 'right'] }
    )

    sectionTitle(doc, 'Rentabilidad por categoría (ingresos, CMV y margen)')
    if (data.categoryProfitability.length) {
      drawTable(
        doc,
        ['Categoría', 'Ingresos', 'CMV', 'Margen', 'Margen %'],
        data.categoryProfitability.map((c) => [
          c.category,
          money(c.revenue),
          money(c.cost),
          money(c.profit),
          `${c.marginPct}%`
        ]),
        [142, 88, 88, 88, 52],
        {
          align: ['left', 'right', 'right', 'right', 'right'],
          headerAlign: ['left', 'right', 'right', 'right', 'right']
        }
      )
    } else {
      ensureSpace(doc, 20)
      doc.fontSize(9).fillColor(BRAND.muted).text('Sin ventas en el período.', doc.page.margins.left)
      doc.moveDown(0.5)
    }

    sectionTitle(doc, 'Compras por proveedor (período)')
    if (data.purchasesBySupplier.length) {
      drawTable(
        doc,
        ['Proveedor', 'Líneas', 'Unidades', 'Monto'],
        data.purchasesBySupplier.map((p) => [p.supplier, p.lines, p.units, money(p.amount)]),
        [238, 52, 70, 102],
        {
          align: ['left', 'right', 'right', 'right'],
          headerAlign: ['left', 'right', 'right', 'right']
        }
      )
    } else {
      ensureSpace(doc, 20)
      doc.fontSize(9).fillColor(BRAND.muted).text('Sin movimientos de compra en el período.', doc.page.margins.left)
      doc.moveDown(0.5)
    }

    footer(doc, companyName)
    doc.end()
  } catch (e) {
    next(e)
  }
}

/** Stock, categoría, proveedor, brechas de reposición y alertas del sistema abiertas. */
async function getAlertsReportData(req) {
  const products = await prisma.product.findMany({
    where: { deleted: false, deleted_at: null, company_id: req.companyId },
    include: { category: true, supplier: true, status: true }
  })
  await overlayReportBranchStock(products, req)

  const gapUnits = (p) => Math.max(0, number(p.min_stock) - number(p.stock))

  const critical = products.filter((p) => number(p.stock) === 0)
  const lowWithStock = products.filter((p) => {
    const st = number(p.stock)
    return st > 0 && st <= number(p.min_stock)
  })
  const atRisk = products.filter((p) => number(p.stock) <= number(p.min_stock))

  let reorderGapUnits = 0
  let reorderGapValue = 0
  for (const p of atRisk) {
    const g = gapUnits(p)
    reorderGapUnits += g
    reorderGapValue += g * number(p.cost)
  }

  const byCategory = {}
  for (const p of atRisk) {
    const c = p.category?.name || 'Sin categoría'
    if (!byCategory[c]) {
      byCategory[c] = { category: c, enRiesgo: 0, sinStock: 0, bajoConStock: 0 }
    }
    byCategory[c].enRiesgo += 1
    if (number(p.stock) === 0) byCategory[c].sinStock += 1
    else byCategory[c].bajoConStock += 1
  }
  const categoryBreakdown = Object.values(byCategory).sort((a, b) => b.enRiesgo - a.enRiesgo)

  const actionList = [...atRisk].sort((a, b) => {
    const dg = gapUnits(b) - gapUnits(a)
    if (dg !== 0) return dg
    return number(a.stock) - number(b.stock)
  })

  const openAlertCount = await prisma.alert.count({ where: { resolved: 0 } })

  const systemAlerts = await prisma.alert.findMany({
    where: { resolved: 0 },
    include: {
      product: { select: { name: true } },
      type: true,
      priority: true,
      status: true,
      assignedTo: { select: { name: true } }
    },
    orderBy: { timestamp: 'desc' },
    take: 250
  })

  return {
    summary: {
      totalSkus: products.length,
      criticalCount: critical.length,
      lowWithStockCount: lowWithStock.length,
      atRiskCount: atRisk.length,
      reorderGapUnits,
      reorderGapValue: Number(reorderGapValue.toFixed(2)),
      openSystemAlerts: openAlertCount
    },
    critical,
    lowWithStock,
    categoryBreakdown,
    actionList,
    systemAlerts
  }
}

async function alertsReport(req, res, next) {
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const { format = 'pdf' } = req.query
    const zone = 'America/Guatemala'
    const data = await getAlertsReportData(req)
    const { summary, categoryBreakdown, actionList, critical, systemAlerts } = data
    const scope = await reportScope(req)
    const byBranch = await stockByBranch(req, scope)

    const gapUnits = (p) => Math.max(0, number(p.min_stock) - number(p.stock))
    const fmtTs = (d) =>
      d ? DateTime.fromJSDate(d).setZone(zone).toFormat('yyyy-LL-dd HH:mm') : '—'

    const whereIs = await topLocationByProduct(req, actionList.map((p) => p.id))
    const rowPrioridad = (p) => [
      p.name,
      p.category?.name || '—',
      number(p.stock),
      whereIs.get(p.id) || '—',
      number(p.min_stock),
      gapUnits(p),
      money(gapUnits(p) * number(p.cost)),
      p.supplier?.name || '—'
    ]

    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      const sections = [
        ...(byBranch.length ? [{
          title: 'Riesgo por Sucursal',
          columns: ['Sucursal', 'SKUs', 'Sin stock', 'Bajo mín. c/stock', 'Unidades', 'Valor'],
          rows: byBranch.map((b) => [b.branch, b.skus, b.sinStock, b.bajoMin, b.units, money(b.value)])
        }] : []),
        {
          title: 'Concentración por categoría (SKUs en riesgo)',
          columns: ['Categoría', 'En riesgo', 'Sin stock', 'Bajo mín. c/stock'],
          rows: categoryBreakdown.map((c) => [
            c.category,
            c.enRiesgo,
            c.sinStock,
            c.bajoConStock
          ])
        },
        {
          title: 'Prioridad de reposición (faltante vs mínimo)',
          columns: [
            'Producto',
            'Categoría',
            'Stock',
            'Dónde está',
            'Mín.',
            'Faltante',
            'Valor faltante',
            'Proveedor'
          ],
          rows: actionList.map(rowPrioridad)
        },
        {
          title: 'Crítico: sin stock',
          columns: ['Producto', 'Categoría', 'Mín.', 'Proveedor', 'Estado stock'],
          rows: critical.map((p) => [
            p.name,
            p.category?.name || '—',
            number(p.min_stock),
            p.supplier?.name || '—',
            p.status?.name || '—'
          ])
        }
      ]
      if (systemAlerts.length) {
        sections.push({
          title: 'Alertas del sistema (abiertas)',
          columns: ['Fecha', 'Tipo', 'Prioridad', 'Producto', 'Título', 'Estado', 'Asignado'],
          rows: systemAlerts.map((a) => [
            fmtTs(a.timestamp),
            a.type?.name || '—',
            a.priority?.name || '—',
            a.product?.name || '—',
            a.title,
            a.status?.name || '—',
            a.assignedTo?.name || '—'
          ])
        })
      }
      const headerLines = [
        'REPORTE DE ALERTAS E INVENTARIO CRÍTICO',
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone(zone).toFormat('yyyy-LL-dd HH:mm')}`,
        `SKUs activos totales,${summary.totalSkus}`,
        `Sin stock (crítico),${summary.criticalCount}`,
        `Bajo mínimo con existencias,${summary.lowWithStockCount}`,
        `SKUs en riesgo (total),${summary.atRiskCount}`,
        `Unidades a reponer hasta mínimo,${summary.reorderGapUnits}`,
        `Valor estimado reposición (faltante * costo),${money(summary.reorderGapValue)}`,
        `Tickets de alerta abiertos (total),${summary.openSystemAlerts}`
      ]
      if (summary.openSystemAlerts > 250) {
        headerLines.push(
          'Nota,La sección CSV de alertas del sistema incluye como máximo 250 registros.'
        )
      }
      sendCsv(res, 'reporte-alertas', headerLines, sections)
      return
    }

    const doc = newDoc(res, 'Reporte de Alertas')
    header(doc, 'Reporte de Alertas', 'Actual', companyName, logoBuffer, scope.label)

    sectionTitle(doc, 'Resumen - riesgo de stock y seguimiento')
    drawSummaryCards(doc, [
      { label: 'Sin stock', value: String(summary.criticalCount) },
      { label: 'Bajo mín. (c/stock)', value: String(summary.lowWithStockCount) },
      { label: 'SKUs en riesgo', value: String(summary.atRiskCount) },
      { label: 'Unid. a reponer', value: String(summary.reorderGapUnits) },
      { label: 'Valor reposición est.', value: money(summary.reorderGapValue) },
      { label: 'Alertas abiertas', value: String(summary.openSystemAlerts) }
    ])
    ensureSpace(doc, 32)
    doc
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(
        `Catálogo activo: ${summary.totalSkus} SKUs. Valor de reposición = unidades faltantes hasta el mínimo * costo actual.`,
        doc.page.margins.left,
        doc.y,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      )
    doc.moveDown(1)

    if (byBranch.length) {
      sectionTitle(doc, 'Riesgo por sucursal')
      drawTable(
        doc,
        ['Sucursal', 'SKUs', 'Sin stock', 'Bajo mín.', 'Unidades', 'Valor'],
        byBranch.map((b) => [b.branch, b.skus, b.sinStock, b.bajoMin, b.units, money(b.value)]),
        [140, 55, 65, 65, 65, 82],
        {
          align: ['left', 'right', 'right', 'right', 'right', 'right'],
          headerAlign: ['left', 'right', 'right', 'right', 'right', 'right']
        }
      )
    }

    if (categoryBreakdown.length) {
      sectionTitle(doc, 'Concentración por categoría')
      drawTable(
        doc,
        ['Categoría', 'En riesgo', 'Sin stock', 'Bajo mín. c/stock'],
        categoryBreakdown.map((c) => [c.category, c.enRiesgo, c.sinStock, c.bajoConStock]),
        [238, 72, 72, 90],
        {
          align: ['left', 'right', 'right', 'right'],
          headerAlign: ['left', 'right', 'right', 'right']
        }
      )
    }

    if (actionList.length) {
      sectionTitle(doc, 'Prioridad de reposición')
      drawTable(
        doc,
        ['Producto', 'Categoría', 'Stock', 'Dónde está', 'Mín.', 'Faltante', 'Valor falt.', 'Proveedor'],
        actionList.slice(0, 120).map(rowPrioridad),
        [104, 50, 32, 84, 32, 40, 62, 70],
        {
          align: ['left', 'left', 'right', 'left', 'right', 'right', 'right', 'left'],
          headerAlign: ['left', 'left', 'right', 'left', 'right', 'right', 'right', 'left']
        }
      )
      if (actionList.length > 120) {
        ensureSpace(doc, 20)
        doc
          .fontSize(8)
          .fillColor(BRAND.muted)
          .text(
            `... y ${actionList.length - 120} productos más. Descarga CSV para el listado completo.`,
            doc.page.margins.left
          )
        doc.moveDown(0.5)
      }
    } else {
      sectionTitle(doc, 'Prioridad de reposición')
      ensureSpace(doc, 16)
      doc.fontSize(9).fillColor(BRAND.muted).text('Ningún SKU bajo el mínimo configurado.', doc.page.margins.left)
      doc.moveDown(0.5)
    }

    if (critical.length) {
      sectionTitle(doc, 'Crítico: sin stock')
      drawTable(
        doc,
        ['Producto', 'Categoría', 'Mín.', 'Proveedor', 'Estado'],
        critical.slice(0, 80).map((p) => [
          p.name,
          p.category?.name || '—',
          number(p.min_stock),
          p.supplier?.name || '—',
          p.status?.name || '—'
        ]),
        [138, 78, 36, 118, 100],
        {
          align: ['left', 'left', 'right', 'left', 'left'],
          headerAlign: ['left', 'left', 'right', 'left', 'left']
        }
      )
    }

    sectionTitle(doc, 'Alertas del sistema (sin resolver)')
    if (systemAlerts.length) {
      drawTable(
        doc,
        ['Fecha', 'Tipo', 'Prioridad', 'Producto', 'Título', 'Estado', 'Asignado'],
        systemAlerts.slice(0, 100).map((a) => [
          fmtTs(a.timestamp),
          a.type?.name || '—',
          a.priority?.name || '—',
          a.product?.name || '—',
          a.title,
          a.status?.name || '—',
          a.assignedTo?.name || '—'
        ]),
        [72, 58, 52, 88, 104, 58, 62],
        {
          align: ['left', 'left', 'left', 'left', 'left', 'left', 'left'],
          headerAlign: ['left', 'left', 'left', 'left', 'left', 'left', 'left']
        }
      )
      const shownAlerts = Math.min(100, systemAlerts.length)
      if (summary.openSystemAlerts > shownAlerts) {
        ensureSpace(doc, 18)
        doc
          .fontSize(8)
          .fillColor(BRAND.muted)
          .text(
            `PDF: primeras ${shownAlerts} de ${summary.openSystemAlerts} alertas. CSV: hasta 250.`,
            doc.page.margins.left
          )
        doc.moveDown(0.5)
      }
    } else {
      ensureSpace(doc, 16)
      doc.fontSize(9).fillColor(BRAND.muted).text('No hay tickets de alerta abiertos.', doc.page.margins.left)
      doc.moveDown(0.5)
    }

    footer(doc, companyName)
    doc.end()
  } catch (e) {
    next(e)
  }
}

/** Catálogo: márgenes, valor a costo vs precio público, mix por categoría y proveedor. */
async function getProductsAnalysisData(req) {
  const products = await prisma.product.findMany({
    where: { deleted: false, deleted_at: null, company_id: req.companyId },
    include: { category: true, supplier: true, status: true }
  })
  await overlayReportBranchStock(products, req)

  let inventoryValue = 0
  let retailInventoryValue = 0
  let marginContrib = 0
  let pricingFlags = 0

  const byCategory = {}
  const bySupplier = {}

  const enriched = products.map((p) => {
    const st = number(p.stock)
    const c = number(p.cost)
    const pr = number(p.price)
    const vInv = st * c
    const vRetail = st * pr
    const contrib = st * (pr - c)
    inventoryValue += vInv
    retailInventoryValue += vRetail
    marginContrib += contrib

    if (pr > 0 && pr < c) pricingFlags += 1
    if (pr > 0 && c <= 0) pricingFlags += 1

    const cat = p.category?.name || 'Sin categoría'
    if (!byCategory[cat]) {
      byCategory[cat] = { category: cat, skus: 0, units: 0, invValue: 0, retailValue: 0, contrib: 0 }
    }
    byCategory[cat].skus += 1
    byCategory[cat].units += st
    byCategory[cat].invValue += vInv
    byCategory[cat].retailValue += vRetail
    byCategory[cat].contrib += contrib

    const sup = p.supplier?.name || '—'
    if (!bySupplier[sup]) {
      bySupplier[sup] = { supplier: sup, skus: 0, units: 0, invValue: 0, retailValue: 0 }
    }
    bySupplier[sup].skus += 1
    bySupplier[sup].units += st
    bySupplier[sup].invValue += vInv
    bySupplier[sup].retailValue += vRetail

    const marginPct = pr > 0 ? Number((((pr - c) / pr) * 100).toFixed(1)) : null

    return {
      ...p,
      units: st,
      invValue: vInv,
      retailValue: vRetail,
      marginPct
    }
  })

  const weightedMarginPct =
    retailInventoryValue > 0
      ? Number(((marginContrib / retailInventoryValue) * 100).toFixed(1))
      : 0

  const categoryRows = Object.values(byCategory)
    .map((row) => ({
      category: row.category,
      skus: row.skus,
      units: row.units,
      invValue: Number(row.invValue.toFixed(2)),
      retailValue: Number(row.retailValue.toFixed(2)),
      marginPct:
        row.retailValue > 0
          ? Number(((row.contrib / row.retailValue) * 100).toFixed(1))
          : 0
    }))
    .sort((a, b) => b.retailValue - a.retailValue)

  const supplierRows = Object.values(bySupplier)
    .map((row) => ({
      supplier: row.supplier,
      skus: row.skus,
      units: row.units,
      invValue: Number(row.invValue.toFixed(2)),
      retailValue: Number(row.retailValue.toFixed(2))
    }))
    .sort((a, b) => b.invValue - a.invValue)

  const topByInv = [...enriched].sort((a, b) => b.invValue - a.invValue).slice(0, 15)
  const topByRetail = [...enriched].sort((a, b) => b.retailValue - a.retailValue).slice(0, 15)
  const tightMargins = [...enriched]
    .filter((p) => p.marginPct !== null && number(p.price) > 0)
    .sort((a, b) => (a.marginPct ?? 100) - (b.marginPct ?? 100))
    .slice(0, 15)

  const supplierCount = supplierRows.filter((s) => s.supplier !== '—').length

  return {
    products: enriched,
    summary: {
      totalSkus: products.length,
      categoryCount: categoryRows.length,
      supplierCount,
      inventoryValue: Number(inventoryValue.toFixed(2)),
      retailInventoryValue: Number(retailInventoryValue.toFixed(2)),
      weightedMarginPct,
      pricingFlags
    },
    categoryRows,
    supplierRows,
    topByInv,
    topByRetail,
    tightMargins
  }
}

async function productsReport(req, res, next) {
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const zone = 'America/Guatemala'
    const { format = 'pdf' } = req.query
    const data = await getProductsAnalysisData(req)
    const { products, summary, categoryRows, supplierRows, topByInv, topByRetail, tightMargins } = data
    const scope = await reportScope(req)
    const byBranch = await stockByBranch(req, scope)
    const byWarehouse = await stockByWarehouse(req)

    const rowDetalle = (p) => [
      p.name,
      p.category?.name || '—',
      p.supplier?.name || '—',
      p.units,
      money(number(p.cost)),
      money(number(p.price)),
      p.marginPct != null ? `${p.marginPct}%` : '—',
      money(p.invValue),
      money(p.retailValue)
    ]

    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      const sections = [
        {
          title: 'Categoría — mix, unidades y margen sobre valor al público',
          columns: ['Categoría', 'SKUs', 'Unidades', 'Valor inv.', 'Valor público', 'Margen %'],
          rows: categoryRows.map((c) => [
            c.category,
            c.skus,
            c.units,
            money(c.invValue),
            money(c.retailValue),
            `${c.marginPct}%`
          ])
        },
        {
          title: 'Proveedor — concentración de catálogo',
          columns: ['Proveedor', 'SKUs', 'Unidades', 'Valor inv.', 'Valor público'],
          rows: supplierRows.map((s) => [
            s.supplier,
            s.skus,
            s.units,
            money(s.invValue),
            money(s.retailValue)
          ])
        },
        {
          title: 'Top valor inventario (costo)',
          columns: ['Producto', 'Categoría', 'Stock', 'Val. inv.', 'PVP', 'Margen %'],
          rows: topByInv.map((p) => [
            p.name,
            p.category?.name || '—',
            p.units,
            money(p.invValue),
            money(number(p.price)),
            p.marginPct != null ? `${p.marginPct}%` : '—'
          ])
        },
        {
          title: 'Top valor al público (stock × PVP)',
          columns: ['Producto', 'Categoría', 'Stock', 'Valor público', 'Val. inv.', 'Margen %'],
          rows: topByRetail.map((p) => [
            p.name,
            p.category?.name || '—',
            p.units,
            money(p.retailValue),
            money(p.invValue),
            p.marginPct != null ? `${p.marginPct}%` : '—'
          ])
        },
        {
          title: 'Márgenes más ajustados (menor % sobre PVP)',
          columns: ['Producto', 'Categoría', 'Costo', 'PVP', 'Margen %'],
          rows: tightMargins.map((p) => [
            p.name,
            p.category?.name || '—',
            money(number(p.cost)),
            money(number(p.price)),
            `${p.marginPct}%`
          ])
        },
        {
          title: 'Catálogo completo',
          columns: [
            'Producto',
            'Categoría',
            'Proveedor',
            'Stock',
            'Costo',
            'PVP',
            'Margen %',
            'Val. inv.',
            'Val. público',
            'Estado stock'
          ],
          rows: products.map((p) => [
            p.name,
            p.category?.name || '—',
            p.supplier?.name || '—',
            p.units,
            money(number(p.cost)),
            money(number(p.price)),
            p.marginPct != null ? `${p.marginPct}%` : '—',
            money(p.invValue),
            money(p.retailValue),
            p.status?.name || '—'
          ])
        }
      ]
      if (byWarehouse.length) {
        sections.unshift({
          title: 'Existencias por Almacén',
          columns: ['Almacén', 'SKUs', 'Unidades', 'Valor inv.'],
          rows: byWarehouse.map((w) => [w.warehouse, w.skus, w.units, money(w.value)])
        })
      }
      if (byBranch.length) {
        sections.unshift({
          title: 'Existencias por Sucursal',
          columns: ['Sucursal', 'SKUs', 'Unidades', 'Valor inv.'],
          rows: byBranch.map((b) => [b.branch, b.skus, b.units, money(b.value)])
        })
      }
      sendCsv(res, 'reporte-productos', [
        'ANÁLISIS DE PRODUCTOS Y CATÁLOGO',
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone(zone).toFormat('yyyy-LL-dd HH:mm')}`,
        `SKUs activos,${summary.totalSkus}`,
        `Categorías,${summary.categoryCount}`,
        `Proveedores (con catálogo),${summary.supplierCount}`,
        `Valor inventario (stock × costo),${money(summary.inventoryValue)}`,
        `Valor al público en existencias (stock × PVP),${money(summary.retailInventoryValue)}`,
        `Margen % ponderado (sobre valor público en stock),${summary.weightedMarginPct}%`,
        `SKUs a revisar precio/costo,${summary.pricingFlags}`
      ], sections)
      return
    }

    const doc = newDoc(res, 'Análisis de Productos')
    header(doc, 'Análisis de Productos', 'Actual', companyName, logoBuffer, scope.label)

    if (byBranch.length) {
      sectionTitle(doc, 'Existencias por sucursal')
      drawTable(
        doc,
        ['Sucursal', 'SKUs', 'Unidades', 'Valor inv.'],
        byBranch.map((b) => [b.branch, b.skus, b.units, money(b.value)]),
        [170, 70, 70, 90],
        { align: ['left', 'right', 'right', 'right'], headerAlign: ['left', 'right', 'right', 'right'] }
      )
    }

    if (byWarehouse.length) {
      sectionTitle(doc, 'Existencias por almacén')
      drawTable(
        doc,
        ['Almacén', 'SKUs', 'Unidades', 'Valor inv.'],
        byWarehouse.map((w) => [w.warehouse, w.skus, w.units, money(w.value)]),
        [170, 70, 70, 90],
        { align: ['left', 'right', 'right', 'right'], headerAlign: ['left', 'right', 'right', 'right'] }
      )
    }

    sectionTitle(doc, 'Resumen - catálogo y rentabilidad de existencias')
    drawSummaryCards(doc, [
      { label: 'SKUs activos', value: String(summary.totalSkus) },
      { label: 'Valor inventario', value: money(summary.inventoryValue) },
      { label: 'Valor al público', value: money(summary.retailInventoryValue) },
      { label: 'Margen % ponderado', value: `${summary.weightedMarginPct}%` },
      { label: 'Categorías', value: String(summary.categoryCount) },
      { label: 'Revisar PVP/costo', value: String(summary.pricingFlags) }
    ])
    ensureSpace(doc, 36)
    doc
      .fontSize(8)
      .fillColor(BRAND.muted)
      .text(
        'Margen % ponderado = suma(stock * (PVP - costo)) / suma(stock * PVP). ' +
          'Revisar: PVP menor que costo o costo en cero con PVP > 0. ' +
          `${summary.supplierCount} proveedores con ítems activos.`,
        doc.page.margins.left,
        doc.y,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      )
    doc.moveDown(1.05)

    sectionTitle(doc, 'Categoría - mix y margen')
    drawTable(
      doc,
      ['Categoría', 'SKUs', 'Unid.', 'Val. inv.', 'Val. público', 'Margen %'],
      categoryRows.map((c) => [
        c.category,
        c.skus,
        c.units,
        money(c.invValue),
        money(c.retailValue),
        `${c.marginPct}%`
      ]),
      [128, 36, 44, 78, 82, 52],
      {
        align: ['left', 'right', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'right', 'right', 'right', 'right', 'right']
      }
    )

    sectionTitle(doc, 'Proveedor - concentración')
    drawTable(
      doc,
      ['Proveedor', 'SKUs', 'Unid.', 'Val. inv.', 'Val. público'],
      supplierRows.slice(0, 25).map((s) => [
        s.supplier,
        s.skus,
        s.units,
        money(s.invValue),
        money(s.retailValue)
      ]),
      [218, 40, 46, 78, 82],
      {
        align: ['left', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'right', 'right', 'right', 'right']
      }
    )
    if (supplierRows.length > 25) {
      ensureSpace(doc, 16)
      doc.fontSize(8).fillColor(BRAND.muted).text(`... ${supplierRows.length - 25} proveedores más en CSV.`, doc.page.margins.left)
      doc.moveDown(0.45)
    }

    sectionTitle(doc, 'Mayor valor a costo (existencias)')
    drawTable(
      doc,
      ['Producto', 'Categoría', 'Stock', 'Val. inv.', 'PVP', 'Margen %'],
      topByInv.map((p) => [
        p.name,
        p.category?.name || '—',
        p.units,
        money(p.invValue),
        money(number(p.price)),
        p.marginPct != null ? `${p.marginPct}%` : '—'
      ]),
      [128, 72, 34, 70, 56, 46],
      {
        align: ['left', 'left', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'left', 'right', 'right', 'right', 'right']
      }
    )

    sectionTitle(doc, 'Mayor valor al público (existencias)')
    drawTable(
      doc,
      ['Producto', 'Categoría', 'Stock', 'Val. público', 'Val. inv.', 'Margen %'],
      topByRetail.map((p) => [
        p.name,
        p.category?.name || '—',
        p.units,
        money(p.retailValue),
        money(p.invValue),
        p.marginPct != null ? `${p.marginPct}%` : '—'
      ]),
      [118, 68, 34, 76, 70, 48],
      {
        align: ['left', 'left', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'left', 'right', 'right', 'right', 'right']
      }
    )

    sectionTitle(doc, 'Márgenes más ajustados')
    drawTable(
      doc,
      ['Producto', 'Categoría', 'Costo', 'PVP', 'Margen %'],
      tightMargins.map((p) => [
        p.name,
        p.category?.name || '—',
        money(number(p.cost)),
        money(number(p.price)),
        `${p.marginPct}%`
      ]),
      [138, 78, 58, 58, 46],
      {
        align: ['left', 'left', 'right', 'right', 'right'],
        headerAlign: ['left', 'left', 'right', 'right', 'right']
      }
    )

    sectionTitle(doc, 'Detalle de catálogo')
    drawTable(
      doc,
      ['Producto', 'Cat.', 'Prov.', 'St.', 'Costo', 'PVP', 'Marg%', 'V.inv', 'V.pub'],
      products.slice(0, 90).map(rowDetalle),
      [102, 46, 50, 24, 52, 52, 36, 52, 52],
      {
        align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right']
      }
    )
    if (products.length > 90) {
      ensureSpace(doc, 18)
      doc
        .fontSize(8)
        .fillColor(BRAND.muted)
        .text(`... ${products.length - 90} productos más en CSV.`, doc.page.margins.left)
      doc.moveDown(0.5)
    }

    footer(doc, companyName)
    doc.end()
  } catch (e) {
    next(e)
  }
}

/**
 * GET /reports/inventory-count-session/:id?format=pdf|csv
 * Resumen de una sesión de inventariado (teórico vs contado, diferencias y valor).
 */
async function inventoryCountSessionReport(req, res, next) {
  try {
    const { id } = req.params
    const format = String(req.query.format || 'pdf').toLowerCase()

    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: {
        createdBy: { select: { name: true, email: true } },
        approvedBy: { select: { name: true, email: true } },
        firstApprovedBy: { select: { name: true, email: true } },
      },
    })
    if (!session) {
      return res.status(404).json({ message: 'Sesión de inventariado no encontrada' })
    }

    const lines = await prisma.inventoryCountLine.findMany({
      where: { session_id: id },
      orderBy: [{ location: { code: 'asc' } }, { product: { name: 'asc' } }],
      include: {
        product: {
          select: {
            name: true,
            barcode: true,
            cost: true,
            category: { select: { name: true } },
          },
        },
        location: { select: { code: true, warehouse: { select: { name: true } } } },
      },
    })

    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)

    if (format === 'csv' || format === 'excel') {
      const rows = lines.map((L) => {
        const diff = L.qty_counted != null ? L.qty_counted - L.stock_snapshot : ''
        const vd =
          L.qty_counted != null
            ? (L.qty_counted - L.stock_snapshot) * number(L.product.cost)
            : ''
        return [
          L.product.name,
          L.product.barcode || '—',
          `${L.location.warehouse.name} · ${L.location.code}`,
          L.product.category?.name || '—',
          L.stock_snapshot,
          L.qty_counted ?? '—',
          L.qty_counted_secondary ?? '—',
          diff === '' ? '—' : diff,
          vd === '' ? '—' : money(vd),
          (L.note || '').replace(/\n/g, ' '),
        ]
      })
      return sendCsv(
        res,
        `inventariado-${String(session.name || id).slice(0, 24).replace(/\s+/g, '-') || id.slice(0, 8)}`,
        [
          'REPORTE DE INVENTARIADO',
          `Sesión,${session.name || id}`,
          `Estado,${inventoryCountStatusLabel(session.status)}`,
          session.submit_reason ? `Motivo envío revisión,${String(session.submit_reason).replace(/,/g, ';')}` : null,
          session.first_approved_at
            ? `1.ª aprobación,${session.firstApprovedBy?.name || '—'} · ${DateTime.fromJSDate(session.first_approved_at).setZone(branding.timezone || 'America/Guatemala').toFormat('dd/LL/yyyy HH:mm')}`
            : null,
          session.first_approval_reason
            ? `Motivo 1.ª aprobación,${String(session.first_approval_reason).replace(/,/g, ';')}`
            : null,
          session.approved_at && session.final_approval_reason
            ? `Motivo aprobación final,${String(session.final_approval_reason).replace(/,/g, ';')}`
            : null,
          `Creado por,${session.createdBy?.name || '—'}`,
          `Generado,${DateTime.now().setZone(branding.timezone || 'America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}`,
        ].filter(Boolean),
        [
          {
            title: 'Líneas',
            columns: ['Producto', 'Código', 'Ubicación', 'Categoría', 'Teórico', 'Contado', '2.ª lectura', 'Diferencia', 'Valor diff.', 'Nota'],
            rows,
          },
        ]
      )
    }

    const doc = newDoc(res, `Inventariado ${session.name || id.slice(0, 8)}`)
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, doc.page.margins.left, doc.y, { fit: [44, 26] })
        doc.moveDown(1.8)
      } catch {
        /* sin logo */
      }
    }
    doc.fontSize(16).fillColor(BRAND.primary).text('Inventariado (conteo físico)', { align: 'left' })
    doc.moveDown(0.3)
    doc
      .fontSize(9)
      .fillColor(BRAND.muted)
      .text(`${companyName} · ${inventoryCountStatusLabel(session.status)}`, { continued: false })
    doc.text(
      `Sesión: ${session.name || id} · Creado: ${session.createdBy?.name || '—'} · ${DateTime.fromJSDate(session.created_at).setZone(branding.timezone || 'America/Guatemala').toFormat('dd/LL/yyyy HH:mm')}`
    )
    if (session.submit_reason) {
      doc.text(`Motivo envío a revisión: ${String(session.submit_reason).slice(0, 500)}`)
    }
    if (session.first_approved_at) {
      doc.text(
        `1.ª aprobación: ${DateTime.fromJSDate(session.first_approved_at).setZone(branding.timezone || 'America/Guatemala').toFormat('dd/LL/yyyy HH:mm')} · ${session.firstApprovedBy?.name || '—'}`
      )
    }
    if (session.first_approval_reason) {
      doc.text(`Motivo 1.ª aprobación: ${String(session.first_approval_reason).slice(0, 400)}`)
    }
    if (session.approved_at) {
      doc.text(
        `Aprobación final: ${DateTime.fromJSDate(session.approved_at).setZone(branding.timezone || 'America/Guatemala').toFormat('dd/LL/yyyy HH:mm')} · ${session.approvedBy?.name || '—'}`
      )
    }
    if (session.final_approval_reason) {
      doc.text(`Motivo aprobación final: ${String(session.final_approval_reason).slice(0, 400)}`)
    }
    doc.moveDown(0.8)

    const tableRows = lines.map((L) => {
      const diff = L.qty_counted != null ? L.qty_counted - L.stock_snapshot : null
      const vd = diff != null ? diff * number(L.product.cost) : null
      return [
        String(L.product.name).slice(0, 22),
        L.product.barcode || '—',
        // En un conteo físico importa más dónde está que de qué categoría es.
        String(L.location.code).slice(0, 10),
        L.stock_snapshot,
        L.qty_counted ?? '—',
        L.qty_counted_secondary ?? '—',
        diff != null ? diff : '—',
        vd != null ? money(vd) : '—',
      ]
    })

    sectionTitle(doc, 'Detalle de líneas')
    drawTable(
      doc,
      ['Producto', 'Cód.', 'Ubic.', 'Teór.', 'C1', 'C2', 'Diff.', 'Valor'],
      tableRows.slice(0, 100),
      [102, 54, 48, 30, 28, 28, 28, 48],
      {
        align: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
      }
    )
    if (lines.length > 100) {
      ensureSpace(doc, 20)
      doc.fontSize(8).fillColor(BRAND.muted).text(`… ${lines.length - 100} líneas más (ver CSV).`, doc.page.margins.left)
    }

    footer(doc, companyName)
    doc.end()
  } catch (e) {
    next(e)
  }
}

function inventoryCountStatusLabel(status) {
  const m = {
    DRAFT: 'Pendiente de empezar',
    IN_PROGRESS: 'Contando',
    IN_REVIEW: 'En revisión',
    PENDING_SECOND_APPROVAL: 'Falta segunda firma',
    APPROVED: 'Cerrado y guardado',
    CANCELLED: 'Cancelado',
  }
  return m[status] || String(status)
}

/**
 * GET /reports/inventory-counts?period=...&year=...&format=pdf|csv
 * Resumen de sesiones de inventariado creadas en el rango: líneas, contadas, valor de diferencias y mermas.
 */
async function inventoryCountsHistoryReport(req, res, next) {
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const zone = branding.timezone || 'America/Guatemala'
    const { period = 'month', year, format = 'pdf', month, quarter, semester } = req.query
    const { startUtc, endUtc, label } = periodRange(period, year, { month, quarter, semester }, zone)

    const sessions = await prisma.inventoryCountSession.findMany({
      where: {
        created_at: { gte: startUtc, lte: endUtc },
      },
      include: {
        createdBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
        _count: { select: { lines: true } },
      },
      orderBy: { created_at: 'desc' },
    })

    const sessionIds = sessions.map((s) => s.id)
    const countedBySession = new Map()
    const valueAgg = new Map()

    if (sessionIds.length) {
      const countedAgg = await prisma.inventoryCountLine.groupBy({
        by: ['session_id'],
        where: { session_id: { in: sessionIds }, qty_counted: { not: null } },
        _count: { id: true },
      })
      for (const c of countedAgg) countedBySession.set(c.session_id, c._count.id)

      const allLines = await prisma.inventoryCountLine.findMany({
        where: { session_id: { in: sessionIds }, qty_counted: { not: null } },
        select: {
          session_id: true,
          stock_snapshot: true,
          qty_counted: true,
          product: { select: { cost: true } },
        },
      })
      for (const L of allLines) {
        const d = L.qty_counted - L.stock_snapshot
        const v = d * number(L.product.cost)
        const prev = valueAgg.get(L.session_id) || { valueDiff: 0, mermaValue: 0 }
        prev.valueDiff += v
        if (d < 0) prev.mermaValue += Math.abs(v)
        valueAgg.set(L.session_id, prev)
      }
    }

    const genAt = DateTime.now().setZone(zone).toFormat('yyyy-LL-dd HH:mm')
    const fmtDate = (d) =>
      d ? DateTime.fromJSDate(d).setZone(zone).toFormat('dd/LL/yyyy HH:mm') : '—'

    const tableData = sessions.map((s) => {
      const agg = valueAgg.get(s.id) || { valueDiff: 0, mermaValue: 0 }
      const counted = countedBySession.get(s.id) || 0
      return {
        s,
        counted,
        ...agg,
      }
    })

    let sumValueDiff = 0
    let sumMerma = 0
    for (const row of tableData) {
      sumValueDiff += row.valueDiff
      sumMerma += row.mermaValue
    }
    const byStatus = sessions.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1
      return acc
    }, {})

    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      const rows = tableData.map(({ s, counted, valueDiff, mermaValue }) => [
        s.name || s.id.slice(0, 8),
        inventoryCountStatusLabel(s.status),
        fmtDate(s.created_at),
        s._count.lines,
        counted,
        money(valueDiff),
        money(mermaValue),
        s.approved_at ? fmtDate(s.approved_at) : '—',
        s.approvedBy?.name || '—',
        s.createdBy?.name || '—',
      ])
      return sendCsv(
        res,
        `historial-inventariados-${label.replace(/\s+/g, '-').slice(0, 40)}`,
        [
          'HISTORIAL DE INVENTARIADOS',
          `Periodo,${label}`,
          `Generado,${genAt}`,
          `Sesiones,${sessions.length}`,
          `Suma valor diferencias (contado),${money(sumValueDiff)}`,
          `Suma mermas (valor),${money(sumMerma)}`,
        ],
        [
          {
            title: 'Sesiones',
            columns: [
              'Sesión',
              'Estado',
              'Creado',
              'Líneas',
              'Contadas',
              'Valor diff.',
              'Merma ($)',
              'Aprobado',
              'Aprobador',
              'Creado por',
            ],
            rows,
          },
        ]
      )
    }

    const doc = newDoc(res, `Historial inventariados ${label}`)
    doc.fontSize(16).fillColor(BRAND.primary).text('Historial de inventariados', { align: 'left' })
    doc.moveDown(0.3)
    doc.fontSize(9).fillColor(BRAND.muted).text(`${companyName} · ${label}`)
    doc.text(`Generado: ${genAt}`)
    doc.moveDown(0.6)

    sectionTitle(doc, 'Resumen')
    drawSummaryCards(doc, [
      { label: 'Sesiones', value: String(sessions.length) },
      { label: 'Aprobadas', value: String(byStatus.APPROVED || 0) },
      { label: 'En curso / revisión', value: String((byStatus.IN_PROGRESS || 0) + (byStatus.IN_REVIEW || 0) + (byStatus.PENDING_SECOND_APPROVAL || 0)) },
      { label: 'Valor dif. (contado)', value: money(sumValueDiff) },
      { label: 'Mermas (valor)', value: money(sumMerma) },
    ])
    doc.moveDown(0.5)

    sectionTitle(doc, 'Sesiones')
    const pdfRows = tableData.map(({ s, counted, valueDiff, mermaValue }) => [
      String(s.name || s.id.slice(0, 8)).slice(0, 26),
      inventoryCountStatusLabel(s.status).slice(0, 12),
      fmtDate(s.created_at).slice(0, 16),
      s._count.lines,
      counted,
      money(valueDiff),
      money(mermaValue),
    ])
    drawTable(
      doc,
      ['Sesión', 'Estado', 'Creado', 'Lín.', 'Cont.', 'Val.diff', 'Merma'],
      pdfRows.slice(0, 80),
      [118, 52, 72, 28, 28, 58, 58],
      {
        align: ['left', 'left', 'left', 'right', 'right', 'right', 'right'],
        headerAlign: ['left', 'left', 'left', 'right', 'right', 'right', 'right'],
      }
    )
    if (tableData.length > 80) {
      ensureSpace(doc, 18)
      doc.fontSize(8).fillColor(BRAND.muted).text(`… ${tableData.length - 80} sesiones más (ver CSV).`, doc.page.margins.left)
    }

    footer(doc, companyName)
    doc.end()
  } catch (e) {
    next(e)
  }
}

async function merchandiseReport(req, res, next) {
  try {
    const branding = await getBrandingForPdf(prisma, req.companyId)
    const companyName = branding.company_name
    const logoBuffer = branding.logoBuffer
    const money = makeMoney(branding.currency_code)
    const { period = 'month', year, format = 'pdf', month, quarter, semester } = req.query
    const { startUtc, endUtc, label } = periodRange(period, year, { month, quarter, semester })

    const scope = await reportScope(req)
    const records = await prisma.incomingMerchandise.findMany({
      // Sin este filtro el reporte mezclaba los ingresos de todas las sucursales
      // (y de todas las empresas).
      where: { ...branchWhere(req), date: { gte: startUtc, lte: endUtc } },
      include: {
        branch: { select: { name: true } },
        supplier: { select: { name: true } },
        registeredBy: { select: { name: true } },
        items: { select: { quantity: true, unit_cost: true } },
      },
      orderBy: { date: 'desc' },
    })

    const statusLabel = (s) => (s === 'PAID' ? 'Pagado' : s === 'PARTIAL' ? 'Pago parcial' : 'Pendiente')
    const recordTotal = (r) => r.items.reduce((sum, it) => sum + number(it.quantity) * number(it.unit_cost), 0)

    let totalAmount = 0
    let paidCount = 0, partialCount = 0, pendingCount = 0
    const bySupplier = new Map()
    const detail = records.map((r) => {
      const total = recordTotal(r)
      totalAmount += total
      if (r.payment_status === 'PAID') paidCount++
      else if (r.payment_status === 'PARTIAL') partialCount++
      else pendingCount++
      const sName = r.supplier?.name || '—'
      const agg = bySupplier.get(sName) || { count: 0, amount: 0 }
      agg.count += 1; agg.amount += total
      bySupplier.set(sName, agg)
      return {
        date: DateTime.fromJSDate(r.date).setZone('America/Guatemala').toFormat('yyyy-LL-dd'),
        branch: r.branch?.name || '—',
        supplier: sName,
        registeredBy: r.registeredBy?.name || '—',
        status: statusLabel(r.payment_status),
        total,
      }
    })
    const supplierRows = [...bySupplier.entries()]
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([name, v]) => [name, String(v.count), money(v.amount)])

    // En consolidado cada ingreso lleva su sucursal; en una sola sobra la columna.
    const detailColumns = scope.consolidated
      ? ['Fecha', 'Sucursal', 'Proveedor', 'Registrado por', 'Estado', 'Total']
      : ['Fecha', 'Proveedor', 'Registrado por', 'Estado', 'Total']
    const detailRows = detail.map((d) =>
      scope.consolidated
        ? [d.date, d.branch, d.supplier, d.registeredBy, d.status, money(d.total)]
        : [d.date, d.supplier, d.registeredBy, d.status, money(d.total)]
    )

    if (String(format).toLowerCase() === 'csv' || String(format).toLowerCase() === 'excel') {
      sendCsv(res, 'reporte-mercancia', [
        'REPORTE DE INGRESOS DE MERCANCÍA',
        `Periodo,${label}`,
        `Sucursal,${scope.label}`,
        `Generado,${DateTime.now().setZone('America/Guatemala').toFormat('yyyy-LL-dd HH:mm')}`,
        `Registros,${records.length}`,
        `Monto Total,${money(totalAmount)}`,
        `Pagados,${paidCount}`,
        `Pago parcial,${partialCount}`,
        `Pendientes,${pendingCount}`,
      ], [
        { title: 'Detalle de Ingresos', columns: detailColumns, rows: detailRows },
        { title: 'Por Proveedor', columns: ['Proveedor', 'Registros', 'Monto'], rows: supplierRows },
      ])
      return
    }

    const doc = newDoc(res, 'Reporte de Mercancía')
    header(doc, 'Reporte de Ingresos de Mercancía', label, companyName, logoBuffer, scope.label)
    sectionTitle(doc, 'Resumen')
    drawSummaryCards(doc, [
      { label: 'Registros', value: String(records.length) },
      { label: 'Monto Total', value: money(totalAmount) },
      { label: 'Pagados', value: String(paidCount) },
      { label: 'Pago parcial', value: String(partialCount) },
      { label: 'Pendientes', value: String(pendingCount) },
    ])
    sectionTitle(doc, 'Detalle de Ingresos')
    drawTable(
      doc,
      detailColumns,
      detailRows,
      scope.consolidated ? [65, 95, 120, 90, 70, 70] : [70, 150, 110, 80, 80],
      scope.consolidated
        ? { align: ['left', 'left', 'left', 'left', 'left', 'right'], headerAlign: ['left', 'left', 'left', 'left', 'left', 'right'] }
        : { align: ['left', 'left', 'left', 'left', 'right'], headerAlign: ['left', 'left', 'left', 'left', 'right'] }
    )
    sectionTitle(doc, 'Por Proveedor')
    drawTable(
      doc,
      ['Proveedor', 'Registros', 'Monto'],
      supplierRows,
      [240, 90, 100],
      { align: ['left', 'right', 'right'], headerAlign: ['left', 'right', 'right'] }
    )
    footer(doc, companyName)
    doc.end()
  } catch (e) { next(e) }
}

module.exports = {
  // Ladrillos compartidos con stockReports.controller.js: los reportes nuevos
  // usan el mismo papel y las mismas tablas, no una copia parecida.
  reportScope,
  scopeBranchIds,
  periodRange,
  number,
  makeMoney,
  newDoc,
  header,
  footer,
  sectionTitle,
  drawTable,
  drawSummaryCards,
  sendCsv,
  salesReport,
  // Expuesto para probarlo sin armar un PDF.
  getFinancialData,
  inventoryReport,
  suppliersReport,
  financialReport,
  alertsReport,
  productsReport,
  merchandiseReport,
  inventoryCountSessionReport,
  inventoryCountsHistoryReport,
}
