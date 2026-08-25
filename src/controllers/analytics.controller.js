/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../models/prisma')
const { DateTime } = require('luxon')

const number = (v) => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

async function analyticsContext(req) {
  const { branchWhere } = require('../middlewares/tenant')
  const now = DateTime.now().setZone('America/Guatemala')
  const completedStatus = await prisma.saleStatus.findFirst({ where: { name: 'Completada' } })
  const minAgg = await prisma.sale.aggregate({
    _min: { date: true },
    where: { ...branchWhere(req), ...(completedStatus ? { status_id: completedStatus.id } : {}) },
  })
  const firstSaleYear = minAgg._min.date
    ? DateTime.fromJSDate(minAgg._min.date, { zone: 'utc' }).setZone('America/Guatemala').year
    : now.year
  return { now, completedStatus, firstSaleYear }
}

exports.firstSaleYear = async (req, res, next) => {
  try {
    const { firstSaleYear } = await analyticsContext(req)
    res.json({ firstSaleYear })
  } catch (e) {
    next(e)
  }
}

exports.summary = async (req, res, next) => {
  try {
    const yearParam = req.query.year
    const { now, completedStatus, firstSaleYear } = await analyticsContext(req)
    const { branchWhere } = require('../middlewares/tenant')
    const tenantSales = branchWhere(req)
    const isAll = String(yearParam || '').toLowerCase() === 'all'
    let year = Number(yearParam || now.year)
    if (!Number.isInteger(year) || year < firstSaleYear) year = firstSaleYear

    const start = isAll
      ? DateTime.fromObject({ year: firstSaleYear, month: 1, day: 1 }, { zone: 'America/Guatemala' })
      : DateTime.fromObject({ year, month: 1, day: 1 }, { zone: 'America/Guatemala' })
    const end = isAll
      ? DateTime.fromObject({ year: now.year, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999 }, { zone: 'America/Guatemala' })
      : DateTime.fromObject({ year, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999 }, { zone: 'America/Guatemala' })

    // `.toJSDate()` convierte la zona correctamente al instante UTC real;
    // reconstruir con Date.UTC a partir de los números de la zona los
    // reetiquetaba como si ya fueran UTC (mismo bug que en sales.controller.js).
    const startUtc = start.toJSDate()
    const endUtc = end.toJSDate()

    // Load sale items joined with sales and products within year range
    const saleItems = await prisma.saleItem.findMany({
      where: {
        sale: {
          ...tenantSales,
          date: { gte: startUtc, lte: endUtc },
          ...(completedStatus ? { status_id: completedStatus.id } : {}),
        },
      },
      include: { sale: true, product: { include: { category: true } } },
    })

    // Cargar todas las ventas del período para calcular devoluciones
    const sales = await prisma.sale.findMany({
      where: {
        ...tenantSales,
        date: { gte: startUtc, lte: endUtc },
        ...(completedStatus ? { status_id: completedStatus.id } : {}),
      },
      select: {
        id: true,
        date: true,
        total: true,
        total_returned: true,
        adjusted_total: true,
        sales_channel: true,
        payment_method: { select: { name: true } },
      }
    })

    // Crear mapa de devoluciones por venta
    const saleReturnsMap = new Map()
    sales.forEach(sale => {
      saleReturnsMap.set(sale.id, {
        totalReturned: number(sale.total_returned),
        adjustedTotal: number(sale.adjusted_total)
      })
    })

    // Aggregate monthly usando sale.total (correcto) y costo desde items
    const monthlyMap = new Map()
    for (let m = 1; m <= 12; m++) monthlyMap.set(m, { month: m, ventas: 0, costo: 0, devoluciones: 0 })
    let totalRevenueGross = 0 // desde sale.total
    let totalCost = 0
    let totalReturns = 0
    let totalUnits = 0
    const productAgg = new Map() // id -> { name, category, ventas(units), revenue }
    const categoryAgg = new Map() // name -> revenue
    const categoryCostAgg = new Map() // name -> costo
    const costByMonth = new Map() // mes -> costo total del mes
    const byPaymentMethod = new Map() // name -> { total, count }
    const byChannel = new Map() // channel -> { total, count }

    // Primero procesar items para productos/categorías/costos
    for (const si of saleItems) {
      const d = new Date(si.sale.date)
      const month = d.getUTCMonth() + 1
      const revenue = number(si.price) * number(si.qty)
      const cost = number(si.qty) * number(si.product?.cost)

      costByMonth.set(month, (costByMonth.get(month) || 0) + cost)
      totalCost += cost
      totalUnits += number(si.qty)

      const pId = si.product_id
      const pName = si.product?.name || 'Producto'
      const pCat = si.product?.category?.name || 'Sin categoría'
      const pEntry = productAgg.get(pId) || { id: pId, name: pName, category: pCat, ventas: 0, revenue: 0 }
      pEntry.ventas += number(si.qty)
      pEntry.revenue += revenue
      productAgg.set(pId, pEntry)

      categoryAgg.set(pCat, number(categoryAgg.get(pCat)) + revenue)
      categoryCostAgg.set(pCat, number(categoryCostAgg.get(pCat)) + cost)
    }

    // Luego procesar sales para totales/devoluciones correctos
    for (const sale of sales) {
      const d = new Date(sale.date)
      const month = d.getUTCMonth() + 1
      const saleTotal = number(sale.total)
      const returned = number(sale.total_returned)

      const monthRow = monthlyMap.get(month)
      monthRow.ventas += saleTotal  // Usar sale.total, no suma de items
      monthRow.devoluciones += returned
      monthRow.costo = costByMonth.get(month) || 0

      totalRevenueGross += saleTotal
      totalReturns += returned

      const net = saleTotal - returned
      const pmName = sale.payment_method?.name || 'Otro'
      const pm = byPaymentMethod.get(pmName) || { total: 0, count: 0 }
      pm.total += net; pm.count += 1
      byPaymentMethod.set(pmName, pm)

      const ch = sale.sales_channel || 'POS'
      const chRow = byChannel.get(ch) || { total: 0, count: 0 }
      chRow.total += net; chRow.count += 1
      byChannel.set(ch, chRow)
    }

    const monthly = Array.from(monthlyMap.values()).map(r => ({
      month: r.month,
      ventas: Number(r.ventas.toFixed(2)),  // sale.total (bruto)
      costo: Number(r.costo.toFixed(2)),
      devoluciones: Number(r.devoluciones.toFixed(2)),
      ventasNetas: Number((r.ventas - r.devoluciones).toFixed(2))  // sale.total - devoluciones
    }))

    const productsCount = productAgg.size
    const topProducts = Array.from(productAgg.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map(p => ({ id: p.id, name: p.name, category: p.category, ventas: p.ventas, revenue: Number(p.revenue.toFixed(2)) }))

    // Calcular revenue ajustado (restando devoluciones) desde sale.total
    const adjustedRevenue = totalRevenueGross - totalReturns
    
    const catEntries = Array.from(categoryAgg.entries())
    const categoryPerformance = catEntries.map(([category, rev]) => ({
      category,
      revenue: Number(number(rev).toFixed(2)),
      cost: Number(number(categoryCostAgg.get(category)).toFixed(2)),
      profit: Number((number(rev) - number(categoryCostAgg.get(category))).toFixed(2)),
      margin: number(rev) > 0 ? Math.round(((number(rev) - number(categoryCostAgg.get(category))) / number(rev)) * 100) : 0,
      percentage: totalRevenueGross > 0 ? Math.round((number(rev) / totalRevenueGross) * 100) : 0,
    })).sort((a, b) => b.revenue - a.revenue)

    const paymentMethods = Array.from(byPaymentMethod.entries())
      .map(([method, v]) => ({ method, total: Number(v.total.toFixed(2)), count: v.count }))
      .sort((a, b) => b.total - a.total)

    const channelLabels = { POS: 'Punto de venta', WHOLESALE: 'Mayoreo', ONLINE: 'En línea' }
    const channels = Array.from(byChannel.entries())
      .map(([channel, v]) => ({ channel, label: channelLabels[channel] || channel, total: Number(v.total.toFixed(2)), count: v.count }))
      .sort((a, b) => b.total - a.total)

    // Inventario: snapshot actual (no depende del año). Por sucursal si hay una
    // activa; espejo total de la empresa en vista consolidada.
    let products
    if (req.branchId) {
      const rows = await prisma.productStock.findMany({
        where: { branch_id: req.branchId, product: { deleted: false } },
        select: {
          stock: true, min_stock: true,
          product: { select: { name: true, cost: true, price: true, category: { select: { name: true } } } },
        },
      })
      products = rows.map((r) => ({
        name: r.product.name, stock: r.stock, min_stock: r.min_stock,
        cost: r.product.cost, price: r.product.price, category: r.product.category,
      }))
    } else {
      products = await prisma.product.findMany({
        where: { deleted: false, company_id: req.companyId },
        select: { name: true, stock: true, min_stock: true, cost: true, price: true, category: { select: { name: true } } },
      })
    }
    let stockValue = 0, retailValue = 0, lowStockCount = 0, outOfStockCount = 0
    const stockByCategory = new Map() // name -> { value, units }
    for (const p of products) {
      const stock = number(p.stock)
      const value = stock * number(p.cost)
      stockValue += value
      retailValue += stock * number(p.price)
      if (stock <= 0) outOfStockCount += 1
      else if (stock <= number(p.min_stock)) lowStockCount += 1
      const cat = p.category?.name || 'Sin categoría'
      const row = stockByCategory.get(cat) || { value: 0, units: 0 }
      row.value += value; row.units += stock
      stockByCategory.set(cat, row)
    }
    const inventoryByCategory = Array.from(stockByCategory.entries())
      .map(([category, v]) => ({ category, value: Number(v.value.toFixed(2)), units: v.units }))
      .sort((a, b) => b.value - a.value)

    // Compras / cuentas por pagar (ingresos de mercancía del período).
    // Excluye cargas de saldo de apertura (source: INITIAL) — esas no son
    // compras operativas, se reportan aparte en `initialInventory`.
    const incoming = await prisma.incomingMerchandise.findMany({
      where: {
        date: { gte: startUtc, lte: endUtc },
        ...(req.branchId
          ? { branch_id: req.branchId }
          : { branch: { company_id: req.companyId } }),
      },
      select: {
        date: true,
        payment_status: true,
        source: true,
        supplier: { select: { name: true } },
        items: { select: { quantity: true, unit_cost: true } },
        paymentEntries: { select: { amount: true } },
      },
    })
    const purchasesMonthly = new Map()
    for (let m = 1; m <= 12; m++) purchasesMonthly.set(m, 0)
    const supplierAgg = new Map()
    let purchasesTotal = 0, payablePending = 0, payableCount = 0
    let initialInventoryTotal = 0, initialInventoryUnits = 0, initialInventoryCount = 0
    for (const inc of incoming) {
      const total = inc.items.reduce((s, it) => s + number(it.quantity) * number(it.unit_cost), 0)
      if (inc.source === 'INITIAL') {
        initialInventoryTotal += total
        initialInventoryUnits += inc.items.reduce((s, it) => s + number(it.quantity), 0)
        initialInventoryCount += 1
        continue
      }
      const paid = inc.paymentEntries.reduce((s, e) => s + number(e.amount), 0)
      const month = new Date(inc.date).getUTCMonth() + 1
      purchasesMonthly.set(month, purchasesMonthly.get(month) + total)
      purchasesTotal += total
      const sName = inc.supplier?.name || '—'
      supplierAgg.set(sName, number(supplierAgg.get(sName)) + total)
      if (inc.payment_status !== 'PAID') {
        payableCount += 1
        payablePending += Math.max(0, total - paid)
      }
    }
    const purchases = {
      total: Number(purchasesTotal.toFixed(2)),
      payableCount,
      payablePending: Number(payablePending.toFixed(2)),
      monthly: Array.from(purchasesMonthly.entries()).map(([month, amount]) => ({ month, amount: Number(amount.toFixed(2)) })),
      topSuppliers: Array.from(supplierAgg.entries())
        .map(([name, amount]) => ({ name, amount: Number(number(amount).toFixed(2)) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 6),
    }
    const initialInventory = {
      total: Number(initialInventoryTotal.toFixed(2)),
      units: initialInventoryUnits,
      count: initialInventoryCount,
    }

    res.json({
      year: isAll ? 'all' : year,
      firstSaleYear,
      totals: {
        totalSales: Number(adjustedRevenue.toFixed(2)), // Ventas netas (sale.total - devoluciones)
        totalSalesGross: Number(totalRevenueGross.toFixed(2)), // sale.total bruto
        totalReturns: Number(totalReturns.toFixed(2)), // Total devuelto
        totalCost: Number(number(totalCost).toFixed(2)),
        totalProfit: Number((adjustedRevenue - number(totalCost)).toFixed(2)), // Profit neto
        productsCount,
        stockRotation: totalUnits, // simple proxy: total units sold
      },
      monthly,
      topProducts,
      categoryPerformance,
      paymentMethods,
      channels,
      inventory: {
        stockValue: Number(stockValue.toFixed(2)),
        retailValue: Number(retailValue.toFixed(2)),
        potentialProfit: Number((retailValue - stockValue).toFixed(2)),
        lowStockCount,
        outOfStockCount,
        productsCount: products.length,
        byCategory: inventoryByCategory,
      },
      purchases,
      initialInventory,
    })
  } catch (e) { next(e) }
}
