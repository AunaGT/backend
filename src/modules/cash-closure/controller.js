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
const { closureNotesWithUnidentifiedCollections } = require('./domain')
const { getTimezone } = require('../../utils/getTimezone')

const number = (v) => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

const { closureScope: checkClosureScopePermission } = require('./access')
const { calculateTheoreticalData } = require('./theoretical')
const { validateDeclaration } = require('./declaration')
const { reviewClosure } = require('./review')

/**
 * GET /api/cash-closures/validate-stocks
 * Valida que no haya productos con stock negativo antes de permitir el cierre
 */
exports.validateStocks = async (req, res, next) => {
  try {
    // Productos con stock negativo EN LA SUCURSAL activa
    const negativeRows = await prisma.productStock.findMany({
      where: { stock: { lt: 0 }, branch_id: req.branchId ?? undefined, product: { deleted: false, company_id: req.companyId } },
      select: { stock: true, product_id: true },
    })
    const stockByProduct = new Map(negativeRows.map((r) => [r.product_id, r.stock]))
    const negativeStockProducts = negativeRows.length === 0 ? [] : await prisma.product.findMany({
      where: {
        id: { in: negativeRows.map((r) => r.product_id) },
        deleted: false
      },
      include: {
        category: true,
        supplier: true,
        status: true
      }
    })

    const hasNegativeStock = negativeStockProducts.length > 0

    return res.json({
      valid: !hasNegativeStock,
      negative_stock_count: negativeStockProducts.length,
      products: negativeStockProducts
        .map(p => ({
          id: p.id,
          name: p.name,
          category: p.category.name,
          supplier: p.supplier?.name || 'Sin proveedor habitual',
          current_stock: stockByProduct.get(p.id) ?? 0,
          barcode: p.barcode,
          status: p.status.name
        }))
        .sort((a, b) => a.current_stock - b.current_stock) // los más negativos primero
    })
  } catch (error) {
    console.error('Error validating stocks:', error)
    next(error)
  }
}

/**
 * GET /api/cash-closures/calculate-theoretical
 * Calcula el cierre teórico basado en las ventas del período
 */
exports.calculateTheoretical = async (req, res, next) => {
  try {
    const data = await calculateTheoreticalData(prisma, req), flow = require('./reviewFlow')
    res.json(await flow.isBlind(prisma, req, data) ? flow.blindView(data) : data)
  }
  catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error) }
}

/**
 * POST /api/cash-closures
 * Registra un nuevo cierre de caja
 */
exports.create = async (req, res, next) => {
  try {
    const body = req.body || {}
    const { startDate, endDate, cashierId } = body
    const own = Boolean(cashierId)
    const scope = checkClosureScopePermission(req, own)
    if (!scope.allowed) return res.status(scope.status).json({ message: scope.message })
    if (own && cashierId !== req.user.sub) return res.status(403).json({ message: 'Solo puede registrar el cierre de su propia caja' })
    require('../../middlewares/tenant').requireBranch(req)
    const unidentified = body.unidentifiedCollectionsAmount
    if (unidentified !== undefined && (typeof unidentified !== 'number' || !Number.isFinite(unidentified) || unidentified < 0 || unidentified > 9999999999.99)) {
      return res.status(400).json({ message: 'El importe de cobros con medio no registrado debe ser un monto válido no negativo' })
    }
    if (typeof body.calculationKey !== 'string' || !body.calculationKey) return res.status(428).json({ message: 'Recalcula el arqueo antes de guardar' })
    const sessionId = body.cash_register_session_id || body.cashRegisterSessionId || null
    if (!own && sessionId) return res.status(400).json({ message: 'El arqueo vinculado a un turno debe registrarse como cierre propio' })
    const created = await prisma.$transaction(async tx => {
      const flow = require('./reviewFlow'), session = sessionId ? await flow.lockDeclaredSession(tx, sessionId) : null
      const data = await calculateTheoreticalData(tx, { ...req, query: { startDate, endDate, cashier_id: cashierId, cash_register_session_id: sessionId } })
      if (data.calculation_key !== body.calculationKey) throw Object.assign(new Error('Los movimientos cambiaron. Recalcula el arqueo antes de guardar; tu conteo no se ha registrado.'), { status: 409 })
      const declaration = validateDeclaration(body, data, { blind: own && await flow.isBlind(tx, req, data) })
      const expected = data.theoretical.net_total
      const difference = Number(declaration.difference)
      const saved = await tx.cashClosure.create({ data: {
        branch_id: req.branchId, date: new Date(), start_date: new Date(data.period.start), end_date: new Date(data.period.end),
        cashier_name: String(req.user.name || body.cashierName || 'Cajero').trim().slice(0,100),
        cashier_id: own ? req.user.sub : undefined,
        opening_float: own ? data.cash_session?.opening_float ?? 0 : null,
        theoretical_total: expected, theoretical_sales: data.theoretical.total_sales, theoretical_returns: data.theoretical.total_returns,
        actual_total: declaration.actualTotal, difference: declaration.difference,
        difference_percentage: expected ? Math.abs(difference / expected * 100) <= 999.99 ? Number((difference / expected * 100).toFixed(2)) : null : 0,
        total_transactions: data.metrics.total_transactions, total_customers: data.metrics.total_customers, average_ticket: data.metrics.average_ticket,
        notes: closureNotesWithUnidentifiedCollections(declaration.notes, data.unidentified_collections_amount), status: 'Pendiente',
      } })
      const savedPayments = []
      for (const { breakdown_key, ...payment } of declaration.payments) savedPayments.push({ ...await tx.cashClosurePayment.create({ data: { cash_closure_id: saved.id, ...payment } }), breakdown_key })
      for (const denomination of declaration.denominations) await tx.cashClosureDenomination.create({ data: { cash_closure_id: saved.id, ...denomination } })
      await require('./snapshots').saveClosureSnapshot(tx, saved.id, data, savedPayments)
      const reviewed = own && await flow.adoptDeclaration(tx, { session, closureId: saved.id, sessionId, data, declaration, companyId: req.companyId, branchId: req.branchId })
      const result = await tx.cashClosure.findUnique({ where: { id: saved.id }, include: { payment_breakdowns: { include: { payment_method: true } }, denominations: { orderBy: { denomination: 'desc' } } } })
      const hydrated = (await require('./snapshots').hydrateClosureSnapshots(tx, [result]))[0]
      // La respuesta de declarar muestra las diferencias, también con conteo ciego.
      return reviewed ? { ...hydrated, review: await flow.readReview(tx, saved.id) } : hydrated
    }, { maxWait: 10000, timeout: 30000 })
    res.status(201).json(created)
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message })
    next(error)
  }
}

/**
 * GET /api/cash-closures
 * Lista los cierres de caja con filtros
 */
exports.list = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    const scope = require('./readAccess').readScope(req, req.query.scope)
    const { ids, page: safePage, pageSize, totalItems, totalPages, summary } = await require('./readQueries').readPage(prisma, scope, { ...req.query, includeSummary: req.query.includeSummary === 'true' })
    const where = { id: { in: ids }, branch_id: { in: scope.branchIds }, branch: { company_id: scope.companyId } }

    const closures = await prisma.cashClosure.findMany({
      where,
      include: {
        payment_breakdowns: {
          include: {
            payment_method: true
          }
        },
        denominations: {
          orderBy: {
            denomination: 'desc'
          }
        },
        cash_register_session: {
          select: {
            id: true,
            cashRegister: { select: { id: true, name: true, code: true } }
          }
        }
      },
      orderBy: [{ date: 'desc' }, { id: 'desc' }]
    })

    res.json({
      items: await require('./snapshots').hydrateClosureSnapshots(prisma, closures),
      ...(summary ? { summary } : {}),
      page: safePage,
      pageSize: Number(pageSize),
      totalPages,
      totalItems,
      nextPage: safePage < totalPages ? safePage + 1 : null,
      prevPage: safePage > 1 ? safePage - 1 : null
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/cash-closures/:id
 * Obtiene el detalle de un cierre de caja
 */
exports.getById = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    const { id } = req.params
    const scope = require('./readAccess').readScope(req)
    await require('./readQueries').assertReadable(prisma, scope, id)

    const closure = await prisma.cashClosure.findFirst({
      where: { id, branch_id: { in: scope.branchIds }, branch: { company_id: scope.companyId } },
      include: {
        payment_breakdowns: {
          include: {
            payment_method: true
          }
        },
        denominations: {
          orderBy: {
            denomination: 'desc'
          }
        },
        cash_register_session: {
          select: {
            id: true,
            opening_float: true,
            opened_at: true,
            closed_at: true,
            cashRegister: { select: { id: true, name: true, code: true } }
          }
        }
      }
    })

    if (!closure) {
      return res.status(404).json({ message: 'Cierre de caja no encontrado' })
    }

    const openingFloat =
      closure.opening_float != null
        ? number(closure.opening_float)
        : closure.cash_register_session?.opening_float != null
          ? number(closure.cash_register_session.opening_float)
          : null

    const frozenClosure = (await require('./snapshots').hydrateClosureSnapshots(prisma, [closure]))[0]
    res.json({
      ...frozenClosure,
      opening_float: openingFloat
    })
  } catch (e) {
    next(e)
  }
}

/**
 * PATCH /api/cash-closures/:id/validate
 * Valida un cierre de caja (firma del supervisor)
 */
exports.validate = async (req, res, next) => {
  try { res.json(await reviewClosure(prisma, req, { signature: true })) }
  catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error) }
}

/**
 * GET /api/cash-closures/last-closure-date
 * Obtiene la fecha del último cierre de caja para sugerir inicio del nuevo período
 */
exports.getLastClosureDate = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'private, no-store')
    const scope = require('./readAccess').lastDateScope(req, req.query.scope)
    const lastClosure = await require('./readQueries').lastClosure(prisma, scope)

    const tz = await getTimezone(prisma, req.companyId)
    const fallbackStart = DateTime.now().setZone(tz).startOf('day').toJSDate()

    res.json({
      last_end_date: lastClosure?.end_date || null,
      last_closure_number: lastClosure?.closure_number || 0,
      suggested_start: lastClosure?.end_date || fallbackStart
    })
  } catch (e) {
    next(e)
  }
}

/**
 * PATCH /api/cash-closures/:id/status
 * Actualiza el estado de un cierre (Aprobado/Rechazado)
 */
exports.updateStatus = async (req, res, next) => {
  try { res.json(await reviewClosure(prisma, req)) }
  catch (error) { if (error.status) return res.status(error.status).json({ message: error.message }); next(error) }
}

module.exports = exports
