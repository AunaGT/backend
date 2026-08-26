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
const { getTimezone } = require('../utils/getTimezone')

const number = (v) => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function isCashPaymentMethodName(name) {
  const n = String(name || '').toLowerCase()
  return n.includes('efectivo') || n.includes('cash')
}

/** Suma el fondo inicial al teórico de efectivo (arqueo por turno). */
async function applyOpeningFloatToCashBreakdown(paymentMethodsMap, openingFloat) {
  const float = number(openingFloat)
  if (float <= 0) {
    return { openingFloat: 0, cashSalesAmount: 0 }
  }

  let cashEntry = null
  for (const method of paymentMethodsMap.values()) {
    if (isCashPaymentMethodName(method.name)) {
      cashEntry = method
      break
    }
  }

  if (!cashEntry) {
    const cashPm = await prisma.paymentMethod.findFirst({
      where: {
        OR: [
          { name: { equals: 'Efectivo', mode: 'insensitive' } },
          { name: { contains: 'efectivo', mode: 'insensitive' } },
          { name: { contains: 'cash', mode: 'insensitive' } }
        ]
      }
    })
    if (cashPm) {
      cashEntry = {
        id: cashPm.id,
        name: cashPm.name,
        theoretical_amount: 0,
        theoretical_count: 0,
        sales: []
      }
      paymentMethodsMap.set(cashPm.id, cashEntry)
    }
  }

  if (!cashEntry) {
    return { openingFloat: float, cashSalesAmount: 0 }
  }

  const cashSalesAmount = number(cashEntry.theoretical_amount)
  cashEntry.theoretical_amount = cashSalesAmount + float
  return { openingFloat: float, cashSalesAmount }
}

/** Verifica permiso según tipo de cierre (día = todos, own = solo mi cierre). Devuelve { allowed } o { allowed: false, status, message }. */
function checkClosureScopePermission(req, isOwnClosure) {
  const user = req.user
  if (!user) return { allowed: false, status: 401, message: 'No autenticado' }
  const perms = Array.isArray(user.permissions) ? user.permissions.map(String) : []
  const isAdmin = (user.role?.name || user.role_name || '').toLowerCase() === 'admin'
  if (isAdmin) return { allowed: true }
  if (isOwnClosure) {
    const has = perms.includes('cashclosure.create') || perms.includes('cashclosure.create_own')
    return has ? { allowed: true } : { allowed: false, status: 403, message: 'No tiene permiso para generar solo su cierre' }
  }
  const has = perms.includes('cashclosure.create') || perms.includes('cashclosure.create_day')
  return has ? { allowed: true } : { allowed: false, status: 403, message: 'No tiene permiso para generar cierre del día' }
}

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
          supplier: p.supplier.name,
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
    // Aceptar tanto startDate/endDate como start_date/end_date; cashier_id opcional para filtrar por cajero
    const startDate = req.query.startDate || req.query.start_date
    const endDate = req.query.endDate || req.query.end_date
    const cashierId = req.query.cashier_id || req.query.cashierId || null
    const cashRegisterSessionIdRaw =
      req.query.cash_register_session_id || req.query.cashRegisterSessionId || null
    const cashRegisterSessionId = cashRegisterSessionIdRaw
      ? String(cashRegisterSessionIdRaw).trim()
      : null

    // Permiso según tipo de cierre: día (sin cashier_id) vs propio (con cashier_id)
    const isOwn = !!cashierId
    const permCheck = checkClosureScopePermission(req, isOwn)
    if (!permCheck.allowed) {
      return res.status(permCheck.status || 403).json({ message: permCheck.message || 'No autorizado' })
    }
    if (isOwn && req.user?.sub && cashierId !== req.user.sub) {
      return res.status(403).json({ message: 'Solo puede generar el cierre de su propia caja' })
    }

    const isAdminRole = String(req.user?.role?.name || req.user?.role_name || '').toLowerCase() === 'admin'

    const tz = await getTimezone(prisma, req.companyId)
    let start
    let end
    let sessionOpeningFloat = 0

    if (isOwn) {
      if (!cashRegisterSessionId) {
        return res.status(400).json({
          message:
            'Para «mi cierre» debe enviar cash_register_session_id (turno ya cerrado en «Nueva venta», pendiente de arqueo).'
        })
      }
      const sess = await prisma.cashRegisterSession.findFirst({
        where: { id: cashRegisterSessionId }
      })
      if (!sess) {
        return res.status(400).json({ message: 'Sesión de caja no encontrada' })
      }
      if (!isAdminRole && String(sess.opened_by_id) !== String(cashierId)) {
        return res.status(403).json({ message: 'La sesión no corresponde a su turno de caja' })
      }
      if (sess.status !== 'CLOSED') {
        return res.status(400).json({
          message:
            'El turno debe estar cerrado en «Nueva venta» (fin de turno) antes de calcular el cierre. Mientras la caja siga abierta no se puede arquear.'
        })
      }
      if (sess.cash_closure_id) {
        return res.status(400).json({ message: 'Este turno de caja ya tiene un cierre de caja registrado.' })
      }
      if (!sess.closed_at) {
        return res.status(400).json({ message: 'La sesión no tiene fecha de cierre; no se puede calcular.' })
      }
      sessionOpeningFloat = number(sess.opening_float)
      // Fuente de verdad: horas del turno en BD (evita desajuste con sold_at vs strings del formulario)
      start = sess.opened_at
      end = sess.closed_at
    } else {
      if (!startDate || !endDate) {
        return res.status(400).json({ message: 'startDate y endDate son requeridos' })
      }
      if (startDate.includes('Z')) {
        start = DateTime.fromISO(startDate, { zone: 'utc' }).setZone(tz).toJSDate()
        end = DateTime.fromISO(endDate, { zone: 'utc' }).setZone(tz).toJSDate()
      } else {
        start = DateTime.fromISO(startDate, { zone: tz }).toJSDate()
        end = DateTime.fromISO(endDate, { zone: tz }).toJSDate()
      }
    }

    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: 'Fechas inválidas' })
    }

    console.log('Calculando cierre para período:', {
      startDate: startDate || '(sesión)',
      endDate: endDate || '(sesión)',
      cashier_id: cashierId || '(todos)',
      cash_register_session_id: cashRegisterSessionId || '(n/a)',
      start: start.toISOString(),
      end: end.toISOString(),
      own_closure: isOwn
    })

    // Obtener estado "Completada"
    const completedStatus = await prisma.saleStatus.findFirst({
      where: { name: 'Completada' }
    })

    const periodOr = {
      OR: [
        { sold_at: { gte: start, lte: end } },
        { date: { gte: start, lte: end } }
      ]
    }

    /**
     * Mi cierre con sesión: NO filtrar por sold_at/date entre opened_at y closed_at.
     * Ventas de antes de la corrección del guardado de fechas (ver sales.controller.js)
     * tienen sold_at con la hora local reetiquetada como UTC, corrida contra los
     * timestamps UTC reales de la sesión → el rango las excluye. cash_register_session_id
     * no depende de esto y sigue siendo la fuente confiable. Legado: sin sesión, sí
     * período + created_by (ahí periodOr ya compara correctamente en ventas nuevas).
     */
    let salesWhere
    if (isOwn && cashRegisterSessionId) {
      salesWhere = {
        status_id: completedStatus?.id,
        OR: [
          { cash_register_session_id: cashRegisterSessionId },
          {
            AND: [
              { cash_register_session_id: null },
              ...(cashierId ? [{ created_by: String(cashierId) }] : []),
              periodOr
            ]
          }
        ]
      }
    } else {
      salesWhere = {
        status_id: completedStatus?.id,
        ...periodOr
      }
      if (cashierId) {
        salesWhere.created_by = String(cashierId)
      }
    }

    // Obtener ventas completadas en el período (opcionalmente filtradas por cajero)
    const { branchWhere } = require('../middlewares/tenant')
    Object.assign(salesWhere, branchWhere(req))
    const sales = await prisma.sale.findMany({
      where: salesWhere,
      include: {
        payment_method: true,
        returns: {
          where: {
            status: { name: 'Completada' }
          }
        }
      }
    })

    // Calcular totales teóricos
    let theoreticalSales = 0
    let theoreticalReturns = 0
    const paymentMethodsMap = new Map()

    for (const sale of sales) {
      const saleAdjusted = number(sale.adjusted_total)
      const saleReturned = number(sale.total_returned)
      
      theoreticalSales += number(sale.total)
      theoreticalReturns += saleReturned

      // Agrupar por método de pago
      const methodKey = sale.payment_method_id
      const methodName = sale.payment_method.name
      
      if (!paymentMethodsMap.has(methodKey)) {
        paymentMethodsMap.set(methodKey, {
          id: methodKey,
          name: methodName,
          theoretical_amount: 0,
          theoretical_count: 0,
          sales: []
        })
      }

      const method = paymentMethodsMap.get(methodKey)
      method.theoretical_amount += saleAdjusted  // Usar adjusted_total (con devoluciones)
      method.theoretical_count += 1
      method.sales.push({
        id: sale.id,
        total: sale.total,
        adjusted_total: sale.adjusted_total,
        returned: sale.total_returned
      })
    }

    let theoreticalTotal = theoreticalSales - theoreticalReturns

    const cashDetail = await applyOpeningFloatToCashBreakdown(paymentMethodsMap, sessionOpeningFloat)
    if (cashDetail.openingFloat > 0) {
      theoreticalTotal += cashDetail.openingFloat
    }

    // Calcular métricas adicionales
    const totalTransactions = sales.length
    const totalCustomers = sales.filter(s => s.customer && s.customer !== 'Desconocido').length
    const averageTicket = totalTransactions > 0 ? theoreticalTotal / totalTransactions : 0

    // Convertir Map a Array
    const paymentBreakdown = Array.from(paymentMethodsMap.values()).map(method => ({
      payment_method_id: method.id,
      payment_method_name: method.name,
      theoretical_amount: Number(method.theoretical_amount.toFixed(2)),
      theoretical_count: method.theoretical_count,
      sales_detail: method.sales
    }))

    res.json({
      period: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      theoretical: {
        total_sales: Number(theoreticalSales.toFixed(2)),
        total_returns: Number(theoreticalReturns.toFixed(2)),
        net_total: Number(theoreticalTotal.toFixed(2))
      },
      cash_session: cashDetail.openingFloat > 0
        ? {
            opening_float: Number(cashDetail.openingFloat.toFixed(2)),
            cash_sales_amount: Number(cashDetail.cashSalesAmount.toFixed(2)),
            expected_cash_in_drawer: Number(
              (cashDetail.cashSalesAmount + cashDetail.openingFloat).toFixed(2)
            )
          }
        : null,
      metrics: {
        total_transactions: totalTransactions,
        total_customers: totalCustomers,
        average_ticket: Number(averageTicket.toFixed(2))
      },
      payment_breakdown: paymentBreakdown
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/cash-closures
 * Registra un nuevo cierre de caja
 */
exports.create = async (req, res, next) => {
  try {
    const {
      startDate,
      endDate,
      cashierName,
      cashierSignature,
      cashierId,
      supervisorName,
      supervisorSignature,
      supervisorId,
      theoreticalTotal,
      theoreticalSales,
      theoreticalReturns,
      actualTotal,
      totalTransactions,
      totalCustomers,
      averageTicket,
      paymentBreakdowns,  // Array de { payment_method_id, theoretical_amount, theoretical_count, actual_amount, actual_count, notes }
      denominations,      // Array de { denomination, type, quantity }
      notes,
      cash_register_session_id: cashRegisterSessionIdBody
    } = req.body
    const authUser = req.user

    // Validaciones
    if (!startDate || !endDate || !cashierName) {
      return res.status(400).json({ message: 'Datos incompletos' })
    }

    // Permiso según tipo de cierre: día (sin cashierId) vs propio (con cashierId)
    const isOwnClosure = !!cashierId
    const permCheck = checkClosureScopePermission(req, isOwnClosure)
    if (!permCheck.allowed) {
      return res.status(permCheck.status || 403).json({ message: permCheck.message || 'No autorizado' })
    }
    if (isOwnClosure && authUser?.sub && cashierId !== authUser.sub) {
      return res.status(403).json({ message: 'Solo puede registrar el cierre de su propia caja' })
    }

    const tz = await getTimezone(prisma, req.companyId)
    // Parsear fechas: vienen sin 'Z', son hora local configurada
    const cleanStartDate = String(startDate).replace('Z', '').replace(/[+-]\d{2}:\d{2}$/, '');
    const cleanEndDate = String(endDate).replace('Z', '').replace(/[+-]\d{2}:\d{2}$/, '');
    
    const startDt = DateTime.fromISO(cleanStartDate, { zone: tz });
    const endDt = DateTime.fromISO(cleanEndDate, { zone: tz });
    
    const startDateUTC = DateTime.utc(
      startDt.year, startDt.month, startDt.day,
      startDt.hour, startDt.minute, startDt.second, startDt.millisecond
    ).toJSDate();
    
    const endDateUTC = DateTime.utc(
      endDt.year, endDt.month, endDt.day,
      endDt.hour, endDt.minute, endDt.second, endDt.millisecond
    ).toJSDate();

    console.log('[CASH CLOSURE] Período:', {
      start: startDateUTC.toISOString(),
      end: endDateUTC.toISOString(),
      startGt: startDt.toFormat('yyyy-MM-dd HH:mm:ss'),
      endGt: endDt.toFormat('yyyy-MM-dd HH:mm:ss')
    });

    // Calcular diferencia
    const difference = number(actualTotal) - number(theoreticalTotal)
    const differencePercentage = theoreticalTotal > 0 
      ? (difference / theoreticalTotal) * 100 
      : 0

    const nowLocal = DateTime.now().setZone(tz);
    const dateUTC = DateTime.utc(
      nowLocal.year, nowLocal.month, nowLocal.day,
      nowLocal.hour, nowLocal.minute, nowLocal.second, nowLocal.millisecond
    ).toJSDate();

    console.log('[CASH CLOSURE] Fecha de creación:', {
      dateUTC: dateUTC.toISOString(),
      dateLocal: nowLocal.toFormat('yyyy-MM-dd HH:mm:ss')
    });

    const cashierUuidStored = isOwnClosure ? (cashierId ? String(cashierId) : authUser?.sub || null) : null
    const supervisorUuid = supervisorId || null
    const rawSession = cashRegisterSessionIdBody ?? req.body.cashRegisterSessionId ?? null
    const cashRegisterSessionId = rawSession ? String(rawSession).trim() : null

    if (isOwnClosure && !cashRegisterSessionId) {
      return res.status(400).json({
        message: 'El cierre por cajero debe incluir cash_register_session_id (turno cerrado en «Nueva venta», pendiente de arqueo).'
      })
    }

    const createdClosure = await prisma.$transaction(async (tx) => {
      let sessionToCloseOnSave = null
      let linkedSession = null
      if (cashRegisterSessionId) {
        linkedSession = await tx.cashRegisterSession.findFirst({
          where: { id: cashRegisterSessionId }
        })
        if (!linkedSession) {
          throw new Error('INVALID_SESSION')
        }

        if (isOwnClosure) {
          if (cashierId && String(linkedSession.opened_by_id) !== String(cashierId)) {
            const adminCloser = String(authUser?.role?.name || authUser?.role_name || '').toLowerCase() === 'admin'
            if (!adminCloser) throw new Error('SESSION_NOT_YOURS')
          }
          if (linkedSession.status !== 'CLOSED') {
            throw new Error('SESSION_NOT_CLOSED')
          }
          if (linkedSession.cash_closure_id) {
            throw new Error('SESSION_ALREADY_LINKED')
          }
        } else if (linkedSession.status === 'OPEN') {
          sessionToCloseOnSave = linkedSession
        }
      }

      const cashClosure = await tx.cashClosure.create({
        data: {
          branch_id: require('../middlewares/tenant').requireBranch(req),
          date: dateUTC,
          opening_float: isOwnClosure && linkedSession ? linkedSession.opening_float : null,
          start_date: startDateUTC,
          end_date: endDateUTC,
          cashier_name: cashierName,
          cashier_signature: cashierSignature || null,
          cashier_id: cashierUuidStored || undefined,
          supervisor_name: supervisorName || null,
          supervisor_signature: supervisorSignature || null,
          supervisor_validated_at: supervisorSignature ? dateUTC : null,
          supervisor_id: supervisorUuid || undefined,
          theoretical_total: theoreticalTotal,
          theoretical_sales: theoreticalSales,
          theoretical_returns: theoreticalReturns,
          actual_total: actualTotal,
          difference: difference,
          difference_percentage: Number(differencePercentage.toFixed(2)),
          total_transactions: totalTransactions,
          total_customers: totalCustomers,
          average_ticket: averageTicket,
          notes: notes || null,
          status: 'Pendiente'
        }
      })

      if (paymentBreakdowns && paymentBreakdowns.length > 0) {
        for (const breakdown of paymentBreakdowns) {
          const methodDiff = number(breakdown.actual_amount) - number(breakdown.theoretical_amount)

          await tx.cashClosurePayment.create({
            data: {
              cash_closure_id: cashClosure.id,
              payment_method_id: breakdown.payment_method_id,
              theoretical_amount: breakdown.theoretical_amount,
              theoretical_count: breakdown.theoretical_count,
              actual_amount: breakdown.actual_amount,
              actual_count: breakdown.actual_count || null,
              difference: methodDiff,
              notes: breakdown.notes || null
            }
          })
        }
      }

      if (denominations && denominations.length > 0) {
        for (const denom of denominations) {
          if (denom.quantity > 0) {
            const subtotal = number(denom.denomination) * denom.quantity

            await tx.cashClosureDenomination.create({
              data: {
                cash_closure_id: cashClosure.id,
                denomination: denom.denomination,
                type: denom.type,
                quantity: denom.quantity,
                subtotal: subtotal
              }
            })
          }
        }
      }

      if (cashRegisterSessionId) {
        if (isOwnClosure) {
          const linked = await tx.cashRegisterSession.updateMany({
            where: { id: cashRegisterSessionId, status: 'CLOSED', cash_closure_id: null },
            data: { cash_closure_id: cashClosure.id }
          })
          if (linked.count !== 1) {
            throw new Error('SESSION_RACE')
          }
        } else if (sessionToCloseOnSave) {
          const upd = await tx.cashRegisterSession.updateMany({
            where: { id: cashRegisterSessionId, status: 'OPEN' },
            data: {
              status: 'CLOSED',
              closed_at: dateUTC,
              closed_by_id: authUser.sub,
              cash_closure_id: cashClosure.id
            }
          })
          if (upd.count !== 1) {
            throw new Error('SESSION_RACE')
          }
        }
      }

      return tx.cashClosure.findUnique({
        where: { id: cashClosure.id },
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
          }
        }
      })
    })

    res.status(201).json(createdClosure)
  } catch (e) {
    if (e.message === 'SESSION_NOT_YOURS') {
      return res.status(403).json({ message: 'La sesión de caja no corresponde a este cajero.' })
    }
    if (e.message === 'INVALID_SESSION') {
      return res.status(400).json({
        message: 'Sesión de caja inválida. Actualice la página y vuelva a intentar.'
      })
    }
    if (e.message === 'SESSION_NOT_CLOSED') {
      return res.status(400).json({
        message:
          'El turno debe estar cerrado en «Nueva venta» antes de guardar el cierre. Mientras la caja siga abierta no se registra el arqueo.'
      })
    }
    if (e.message === 'SESSION_ALREADY_LINKED') {
      return res.status(400).json({ message: 'Este turno de caja ya tiene un cierre registrado.' })
    }
    if (e.message === 'SESSION_RACE') {
      return res.status(409).json({ message: 'La sesión de caja ya fue cerrada por otro proceso.' })
    }
    next(e)
  }
}

/**
 * GET /api/cash-closures
 * Lista los cierres de caja con filtros
 */
exports.list = async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20, status, startDate, endDate } = req.query

    const where = { ...require('../middlewares/tenant').branchWhere(req) }
    
    if (status) {
      where.status = status
    }

    if (startDate && endDate) {
      where.date = {
        gte: new Date(startDate),
        lte: new Date(endDate)
      }
    }

    const totalItems = await prisma.cashClosure.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / Number(pageSize)))
    const safePage = Math.min(Number(page), totalPages)

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
      orderBy: {
        date: 'desc'
      },
      skip: (safePage - 1) * Number(pageSize),
      take: Number(pageSize)
    })

    res.json({
      items: closures,
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
    const { id } = req.params

    const closure = await prisma.cashClosure.findFirst({
      where: { id, ...require('../middlewares/tenant').branchWhere(req) },
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

    res.json({
      ...closure,
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
  try {
    const { id } = req.params
    const { supervisorName, supervisorSignature } = req.body

    if (!supervisorName || !supervisorSignature) {
      return res.status(400).json({ message: 'Nombre y firma del supervisor son requeridos' })
    }

    const tz = await getTimezone(prisma, req.companyId)
    const nowLocal = DateTime.now().setZone(tz);
    const validatedAtUTC = DateTime.utc(
      nowLocal.year, nowLocal.month, nowLocal.day,
      nowLocal.hour, nowLocal.minute, nowLocal.second, nowLocal.millisecond
    ).toJSDate();

    const target = await prisma.cashClosure.findFirst({
      where: { id, ...require('../middlewares/tenant').branchWhere(req) },
      select: { id: true },
    })
    if (!target) return res.status(404).json({ message: 'Cierre no encontrado' })

    // status se mantiene (Pendiente); aprobación/rechazo vía PATCH :id/status
    const updated = await prisma.cashClosure.update({
      where: { id },
      data: {
        supervisor_name: supervisorName,
        supervisor_signature: supervisorSignature,
        supervisor_validated_at: validatedAtUTC
      },
      include: {
        payment_breakdowns: {
          include: {
            payment_method: true
          }
        },
        denominations: true
      }
    })

    res.json(updated)
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/cash-closures/last-closure-date
 * Obtiene la fecha del último cierre de caja para sugerir inicio del nuevo período
 */
exports.getLastClosureDate = async (req, res, next) => {
  try {
    const scope = String(req.query.scope || 'day').toLowerCase() === 'mine' ? 'mine' : 'day'
    const authUser = req.user

    const where = {
      ...require('../middlewares/tenant').branchWhere(req),
      ...(scope === 'mine' && authUser?.sub ? { cashier_id: authUser.sub } : {}),
    }

    const lastClosure = await prisma.cashClosure.findFirst({
      where,
      orderBy: {
        end_date: 'desc'
      },
      select: {
        end_date: true,
        closure_number: true
      }
    })

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
  try {
    const { id } = req.params
    const { status, supervisor_name, supervisor_id: bodySupervisorId, rejection_reason } = req.body
    const authUser = req.user

    // Validar que el estado sea válido
    const validStatuses = ['Aprobado', 'Rechazado', 'Pendiente']
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        message: 'Estado inválido. Debe ser: Aprobado, Rechazado o Pendiente' 
      })
    }

    // Buscar el cierre
    const closure = await prisma.cashClosure.findFirst({
      where: { id, ...require('../middlewares/tenant').branchWhere(req) }
    })

    if (!closure) {
      return res.status(404).json({ message: 'Cierre no encontrado' })
    }

    // Actualizar el estado
    const updateData = {
      status,
      updated_at: new Date()
    }

    // Si se aprueba, registrar supervisor y fecha de validación
    if (status === 'Aprobado') {
      if (supervisor_name) {
        updateData.supervisor_name = supervisor_name
      }
      updateData.supervisor_validated_at = new Date()
      const supervisorUuid = bodySupervisorId || authUser?.sub || null
      if (supervisorUuid) {
        updateData.supervisor_id = supervisorUuid
      }
    }

    if (status === 'Rechazado' && rejection_reason) {
      const tz = await getTimezone(prisma, req.companyId)
      const nowStr = DateTime.now().setZone(tz).toFormat('dd/MM/yyyy HH:mm')
      const existingNotes = closure.notes || ''
      updateData.notes = existingNotes 
        ? `${existingNotes}\n\n--- RECHAZADO ---\nRazón: ${rejection_reason}\nFecha: ${nowStr}`
        : `--- RECHAZADO ---\nRazón: ${rejection_reason}\nFecha: ${nowStr}`
    }

    const updatedClosure = await prisma.cashClosure.update({
      where: { id },
      data: updateData,
      include: {
        payment_breakdowns: {
          include: {
            payment_method: true
          }
        },
        denominations: true,
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

    res.json(updatedClosure)
  } catch (e) {
    console.error('Error updating closure status:', e)
    next(e)
  }
}

module.exports = exports
