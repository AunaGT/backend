/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma, prismaTransaction } = require('../../models/prisma')
const { DateTime } = require('luxon')
const {
  getAvailabilityBatchWithKits,
} = require('../../services/bomStock')
const { branchWhere } = require('../../middlewares/tenant')
const { getReturnPolicy } = require('../../services/returnPolicy')
const { nextDocumentReference } = require('../../services/referenceGenerator')
const {
  ACTIVE_RETURN_STATUSES,
  RETURN_RESOLUTIONS,
  availableReturnQty,
  assertReturnTransition,
  buildReturnWhere,
  evaluateReturnEligibility,
  estimateRefundAmount,
  normalizeReturnLines,
  returnFiscalStatus,
} = require('./domain')
const { approveReturn, completeReturn } = require('./application')
const { presentReturnDetail } = require('./presentation')
const { resolvePricedSaleItems } = require('../sales/application')

/** Resuelve sale_id (UUID o referencia ej. V-000001) al id interno de la venta */
async function resolveSaleId(saleIdOrRef, scope) {
  if (!saleIdOrRef) return null
  const s = String(saleIdOrRef).trim()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  const sale = await prisma.sale.findFirst({
    where: isUuid ? { id: s, ...scope } : { reference: s, ...scope },
    select: { id: true },
  })
  return sale?.id ?? null
}

/**
 * GET /api/returns
 * List all returns with optional filtering
 * Query params: status, page, pageSize, sale_id (UUID o referencia)
 */
exports.list = async (req, res, next) => {
  try {
    const { status, sale_id, search, type, reason, date_from, date_to } = req.query || {}
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize ?? 50)))

    // Una devolución "vive" en la sucursal de su venta.
    const where = buildReturnWhere(branchWhere(req), { status, search, type, reason, date_from, date_to })

    if (sale_id) {
      const resolvedId = await resolveSaleId(sale_id, branchWhere(req))
      if (resolvedId) where.sale_id = resolvedId
    }

    const totalItems = await prisma.return.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)

    const items = await prisma.return.findMany({
      where,
      include: {
        sale: {
          include: {
            status: true,
            payment_method: true,
            customerContact: { select: { id: true, name: true } },
            branch: { select: { id: true, name: true, code: true } }
          }
        },
        status: true,
        return_items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                barcode: true
              }
            },
            sale_item: true
          }
        },
        replacement_items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                barcode: true
              }
            }
          }
        }
      },
      orderBy: { return_date: 'desc' },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    const nextPage = safePage < totalPages ? safePage + 1 : null
    const prevPage = safePage > 1 ? safePage - 1 : null

    res.json({
      items,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage,
      prevPage,
    })
  } catch (e) {
    next(e)
  }
}

/** GET /api/returns/eligible-sales - ventas completadas con unidades aún retornables. */
exports.eligibleSales = async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim()
    const requestedSaleId = req.query.sale_id
    const page = Math.max(1, Number(req.query.page || 1))
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10)))
    const resolvedSaleId = requestedSaleId ? await resolveSaleId(requestedSaleId, branchWhere(req)) : null
    const where = {
      ...branchWhere(req),
      ...(!requestedSaleId && { status: { name: 'Completada' } }),
      ...(requestedSaleId && { id: resolvedSaleId || '__not_found__' }),
      ...(search && {
        OR: [
          { reference: { contains: search, mode: 'insensitive' } },
          { customer: { contains: search, mode: 'insensitive' } },
          { customerContact: { is: { name: { contains: search, mode: 'insensitive' } } } },
        ],
      }),
    }
    const [sales, policy] = await Promise.all([prisma.sale.findMany({
      where,
      select: {
        id: true,
        reference: true,
        date: true,
        total: true,
        customer: true,
        status: { select: { name: true } },
        customerContact: { select: { id: true, name: true } },
        sale_items: {
          select: {
            id: true,
            qty: true,
            price: true,
            product_id: true,
            product: { select: { id: true, name: true, barcode: true, image_url: true } },
            return_items: {
              select: { qty_returned: true, return: { select: { status: { select: { name: true } } } } },
            },
          },
        },
      },
      orderBy: { date: 'desc' },
    }), getReturnPolicy(prisma, req.companyId)])
    const eligible = sales.map((sale) => {
      const grossTotal = sale.sale_items.reduce((sum, item) => sum + Number(item.price) * item.qty, 0)
      const saleItems = sale.sale_items.map((item) => ({
        ...item,
        estimated_unit_refund: estimateRefundAmount({
          saleTotal: sale.total,
          grossTotal,
          unitPrice: item.price,
          qty: 1,
        }),
        available_to_return: availableReturnQty(item.qty, item.return_items.map((row) => ({
          qty_returned: row.qty_returned,
          status: row.return.status,
        }))),
        return_items: undefined,
      })).filter((item) => item.available_to_return > 0)
      const eligibility = evaluateReturnEligibility({
        saleDate: sale.date,
        statusName: sale.status?.name,
        availableUnits: saleItems.reduce((sum, item) => sum + item.available_to_return, 0),
        policy,
      })
      return {
        ...sale,
        sale_items: saleItems,
        eligible: eligibility.eligible,
        days_elapsed: eligibility.daysElapsed,
        eligibility_reasons: eligibility.reasons,
        return_policy: policy,
      }
    }).filter((sale) => requestedSaleId || sale.eligible)
    const totalItems = eligible.length
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)
    res.json({
      items: eligible.slice((safePage - 1) * pageSize, safePage * pageSize),
      page: safePage,
      pageSize,
      totalItems,
      totalPages,
      nextPage: safePage < totalPages ? safePage + 1 : null,
      prevPage: safePage > 1 ? safePage - 1 : null,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /api/returns/:id
 * Get a specific return by ID
 */
exports.getById = async (req, res, next) => {
  try {
    const { id } = req.params

    const returnRecord = await prisma.return.findFirst({
      where: { id, sale: { ...branchWhere(req) } },
      include: {
        sale: {
          include: {
            status: true,
            payment_method: true,
            customerContact: { select: { id: true, name: true } },
            sale_dtes: true,
            branch: { select: { id: true, name: true, code: true } },
            sale_items: {
              include: {
                product: true
              }
            }
          }
        },
        status: true,
        return_items: {
          include: {
            product: true,
            sale_item: true
          }
        },
        replacement_items: {
          include: {
            product: true
          }
        },
        settlements: {
          include: {
            payment_method: true,
            cash_register_session: {
              include: { cashRegister: { select: { id: true, name: true, code: true } } }
            }
          },
          orderBy: { created_at: 'asc' }
        }
      }
    })

    if (!returnRecord) {
      return res.status(404).json({ message: 'Devolución no encontrada' })
    }

    const actorIds = [returnRecord.approved_by, returnRecord.processed_by, returnRecord.policy_overridden_by].filter(Boolean)
    const actors = actorIds.length ? await prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true, email: true },
    }) : []
    res.json({
      ...presentReturnDetail(returnRecord, actors),
      return_policy: await getReturnPolicy(prisma, req.companyId),
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/returns
 * Create a new return
 * Body: { sale_id, reason, items: [{ sale_item_id, product_id, qty_returned }] }
 */
exports.create = async (req, res, next) => {
  try {
    const { sale_id: saleIdOrRef, reason, items, notes, type, replacements, policy_override_reason } = req.body
    const requestedResolution = String(req.body.requested_resolution || (type === 'EXCHANGE' ? 'EXCHANGE' : 'REFUND_ORIGINAL'))
    const returnType = requestedResolution === 'EXCHANGE' ? 'EXCHANGE' : 'REFUND'
    const cleanReason = String(reason || '').trim()

    if (type && !['REFUND', 'EXCHANGE'].includes(type)) {
      return res.status(400).json({ message: 'Tipo de devolución no válido.' })
    }
    if (!RETURN_RESOLUTIONS.includes(requestedResolution)) {
      return res.status(400).json({ message: 'La solución solicitada no es válida.' })
    }

    if (!saleIdOrRef || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: 'sale_id e items son requeridos. items debe ser un array no vacío.'
      })
    }

    if (!cleanReason) {
      return res.status(400).json({ message: 'El motivo de la devolución es requerido.' })
    }

    const sale_id = await resolveSaleId(saleIdOrRef, branchWhere(req))
    if (!sale_id) {
      return res.status(404).json({ message: 'Venta no encontrada' })
    }

    const created = await prismaTransaction.$transaction(async (tx) => {
      // Serializa solicitudes sobre la misma venta para que dos peticiones no
      // consuman simultáneamente las últimas unidades disponibles.
      await tx.$queryRaw`SELECT id FROM sales WHERE id = ${sale_id}::uuid FOR UPDATE`

      // 1. Validar que la venta existe y está completada
      const [sale, policy] = await Promise.all([tx.sale.findFirst({
        where: { id: sale_id, ...branchWhere(req) },
        include: {
          status: true,
          branch: { select: { id: true, code: true, seq: true } },
          sale_items: {
            include: {
              product: true,
              return_items: {
                select: {
                  qty_returned: true,
                  return: { select: { status: { select: { name: true } } } },
                },
              },
            }
          },
          returns: {
            where: { status: { name: { in: ACTIVE_RETURN_STATUSES } } },
            select: { total_refund: true },
          },
        }
      }), getReturnPolicy(tx, req.companyId)])

      if (!sale) {
        const err = new Error('Venta no encontrada')
        err.status = 404
        throw err
      }

      if (sale.status.name !== 'Completada') {
        const err = new Error(`Solo se pueden procesar devoluciones de ventas completadas. Estado actual: ${sale.status.name}`)
        err.status = 400
        throw err
      }

      const canOverridePolicy = String(req.user?.role?.name || req.user?.role_name || '').toLowerCase() === 'admin' ||
        (Array.isArray(req.user?.permissions) && req.user.permissions.includes('returns.override_policy'))
      const policyResult = evaluateReturnEligibility({
        saleDate: sale.date,
        statusName: sale.status.name,
        availableUnits: sale.sale_items.reduce((sum, item) => sum + availableReturnQty(item.qty, item.return_items.map((row) => ({ qty_returned: row.qty_returned, status: row.return.status }))), 0),
        policy,
        override: { authorized: canOverridePolicy, reason: policy_override_reason },
      })
      if (policyResult.reasons.includes('RETURN_WINDOW_EXPIRED') && String(policy_override_reason || '').trim() && !canOverridePolicy) {
        const err = new Error('No tienes permiso para autorizar una devolución fuera de plazo.')
        err.status = 403
        throw err
      }
      if (!policyResult.eligible) {
        const expired = policyResult.reasons.includes('RETURN_WINDOW_EXPIRED')
        const err = new Error(expired
          ? `La venta superó el plazo configurable de ${policy.windowDays} días para devoluciones.`
          : 'La venta ya no tiene unidades elegibles para devolución.')
        err.status = expired ? 409 : 400
        throw err
      }
      if (!policy.enabledResolutions.includes(requestedResolution)) {
        const err = new Error('La solución solicitada está deshabilitada por la política de la empresa.')
        err.status = 409
        throw err
      }

      // 2. Validar items y calcular totales
      const normalizedItems = normalizeReturnLines(items)
      const saleItemsMap = new Map(
        sale.sale_items.map(si => [si.id, si])
      )
      const grossTotal = sale.sale_items.reduce((sum, item) => sum + Number(item.price) * item.qty, 0)
      const alreadyReservedAmount = sale.returns.reduce((sum, item) => sum + Number(item.total_refund), 0)
      const availableNetAmount = Math.max(0, Number(sale.total) - alreadyReservedAmount)

      let totalRefund = 0
      const validatedItems = []

      for (const item of normalizedItems) {
        const { sale_item_id, product_id, qty_returned } = item

        if (!sale_item_id || !product_id || !qty_returned || qty_returned <= 0) {
          const err = new Error('Cada item debe tener sale_item_id, product_id y qty_returned > 0')
          err.status = 400
          throw err
        }

        const saleItem = saleItemsMap.get(Number(sale_item_id))
        if (!saleItem) {
          const err = new Error(`Sale item ${sale_item_id} no encontrado en la venta`)
          err.status = 400
          throw err
        }

        if (saleItem.product_id !== product_id) {
          const err = new Error(`Product ID mismatch para sale_item ${sale_item_id}`)
          err.status = 400
          throw err
        }

        const activeReturns = saleItem.return_items.map((row) => ({
          qty_returned: row.qty_returned,
          status: row.return.status,
        }))
        const availableToReturn = availableReturnQty(saleItem.qty, activeReturns)
        const previouslyReturned = saleItem.qty - availableToReturn

        if (qty_returned > availableToReturn) {
          const err = new Error(
            `${saleItem.product.name}: solo se pueden devolver ${availableToReturn} unidades ` +
            `(vendidas: ${saleItem.qty}, ya devueltas: ${previouslyReturned})`
          )
          err.status = 400
          throw err
        }

        const refundAmount = estimateRefundAmount({
          saleTotal: sale.total,
          grossTotal,
          unitPrice: saleItem.price,
          qty: qty_returned,
        })
        totalRefund += refundAmount

        validatedItems.push({
          sale_item_id: Number(sale_item_id),
          product_id,
          qty_returned: Number(qty_returned),
          refund_amount: refundAmount,
          reason: item.reason || null
        })
      }

      if (totalRefund > availableNetAmount + 0.001) {
        const err = new Error(`El reembolso excede el neto disponible de la venta (${availableNetAmount.toFixed(2)})`)
        err.status = 409
        throw err
      }

      // 2b. Validar productos de reemplazo (solo cambios) y calcular la diferencia
      const validatedReplacements = []
      let replacementTotal = 0
      if (returnType === 'EXCHANGE') {
        const resolved = await resolvePricedSaleItems(tx, {
          items: replacements,
          branchId: sale.branch_id,
          companyId: req.companyId,
          customerContactId: sale.customer_contact_id,
          salesChannel: sale.sales_channel,
          pricing: policy.exchangePricing,
          originalSaleItems: sale.sale_items,
          availability: getAvailabilityBatchWithKits,
        })
        for (const rep of resolved) {
          replacementTotal += rep.line_total
          validatedReplacements.push({
            product_id: rep.product_id,
            qty: rep.qty,
            unit_price: rep.unit_price,
            line_total: rep.line_total,
          })
        }
      }
      // + = el cliente paga la diferencia; − = el depósito se la devuelve.
      const priceDifference = returnType === 'EXCHANGE' ? replacementTotal - totalRefund : 0

      // 3. Obtener estado "Pendiente" para devoluciones
      const pendingStatus = await tx.returnStatus.findFirst({
        where: { name: 'Pendiente' }
      })

      if (!pendingStatus) {
        const err = new Error('Estado "Pendiente" no encontrado en return_statuses')
        err.status = 500
        throw err
      }


      const nowGt = DateTime.now().setZone('America/Guatemala');
      const returnDate = DateTime.utc(
        nowGt.year,
        nowGt.month,
        nowGt.day,
        nowGt.hour,
        nowGt.minute,
        nowGt.second,
        nowGt.millisecond
      ).toJSDate();

      console.log('[RETURN DATE] Guatemala local time:', nowGt.toFormat('yyyy-MM-dd HH:mm:ss'));

      // 4. Crear la devolución
      const returnRecord = await tx.return.create({
        data: {
          reference: await nextDocumentReference(tx, 'D', sale.branch),
          sale_id,
          type: returnType,
          requested_resolution: requestedResolution,
          reason: cleanReason,
          notes: [
            String(notes || '').trim(),
            policyResult.exceptionApplied ? `Excepción de plazo autorizada: ${String(policy_override_reason).trim()}` : '',
          ].filter(Boolean).join('\n') || null,
          total_refund: totalRefund,
          price_difference: priceDifference,
          items_count: validatedItems.length,
          status_id: pendingStatus.id,
          return_date: returnDate,
          ...(policyResult.exceptionApplied && {
            policy_override_reason: String(policy_override_reason).trim(),
            policy_overridden_by: req.user?.sub || null,
            policy_overridden_at: new Date(),
          })
        }
      })

      // 5. Crear los items de devolución
      for (const item of validatedItems) {
        await tx.returnItem.create({
          data: {
            return_id: returnRecord.id,
            ...item
          }
        })
      }

      // 5b. Crear los productos de reemplazo (cambios)
      for (const rep of validatedReplacements) {
        await tx.returnReplacementItem.create({
          data: {
            return_id: returnRecord.id,
            ...rep
          }
        })
      }

      console.log(`[RETURN CREATED] ID: ${returnRecord.id}, Sale: ${sale_id}, Items: ${validatedItems.length}, Total Refund: ${totalRefund}`)

      return returnRecord
    }, {
      maxWait: 10000,
      timeout: 15000
    })

    // Cargar el registro completo para devolverlo
    const fullReturn = await prisma.return.findUnique({
      where: { id: created.id },
      include: {
        sale: {
          include: {
            status: true,
            payment_method: true,
            branch: { select: { id: true, name: true, code: true } }
          }
        },
        status: true,
        return_items: {
          include: {
            product: true,
            sale_item: true
          }
        },
        replacement_items: {
          include: {
            product: true
          }
        }
      }
    })

    res.status(201).json(fullReturn)
  } catch (e) {
    next(e)
  }
}

/**
 * PATCH /api/returns/:id/status
 * Update return status (and process stock adjustments if approved/completed)
 * Body: { status_name: 'Aprobada' | 'Rechazada' | 'Completada' }
 */
exports.updateStatus = async (req, res, next) => {
  try {
    const { id } = req.params
    const { status_name } = req.body

    if (!id || !status_name) {
      return res.status(400).json({ message: 'id y status_name son requeridos' })
    }

    if (status_name === 'Aprobada') {
      const result = await prismaTransaction.$transaction(async (tx) => approveReturn(tx, {
        id,
        scope: branchWhere(req),
        userId: req.user?.sub,
        resolution: req.body.approved_resolution,
        lines: req.body.lines,
        policy: await getReturnPolicy(tx, req.companyId),
        companyId: req.companyId,
        replacements: req.body.replacements,
      }), { maxWait: 10000, timeout: 15000 })
      return res.json(result)
    }
    if (status_name === 'Completada') {
      const result = await completeReturn(prismaTransaction, {
        id,
        scope: branchWhere(req),
        userId: req.user?.sub,
        companyId: req.companyId,
        payload: req.body,
      })
      return res.json(result)
    }
    if (status_name !== 'Rechazada') {
      return res.status(400).json({ message: `Estado "${status_name}" no permitido` })
    }

    const result = await prismaTransaction.$transaction(async (tx) => {
      const currentReturn = await tx.return.findFirst({
        where: { id, sale: { ...branchWhere(req) } },
        include: {
          sale: { select: { branch_id: true } },
          status: true,
        }
      })

      if (!currentReturn) {
        const err = new Error('Devolución no encontrada')
        err.status = 404
        throw err
      }

      const newStatus = await tx.returnStatus.findFirst({
        where: { name: String(status_name) }
      })

      if (!newStatus) {
        const err = new Error(`Estado "${status_name}" no encontrado`)
        err.status = 400
        throw err
      }

      const prevStatusName = currentReturn.status.name
      const newStatusName = newStatus.name
      try {
        assertReturnTransition(prevStatusName, newStatusName)
      } catch (error) {
        error.status = 400
        throw error
      }

      // Algunas aprobaciones históricas sí restauraron stock. No pueden
      // rechazarse hasta clasificarlas para evitar dejar inventario ficticio.
      if (prevStatusName === 'Aprobada' && newStatusName === 'Rechazada') {
        const priorStockEffects = await tx.stockMovement.count({
          where: { reason: 'SALE_RETURN', ref_type: 'return', ref_id: id },
        })
        if (priorStockEffects > 0) {
          const err = new Error('Esta devolución aprobada ya movió inventario y requiere conciliación antes de rechazarse.')
          err.status = 409
          throw err
        }
      }

      const updated = await tx.return.update({
        where: { id },
        data: {
          status_id: newStatus.id,
        },
        include: {
          sale: true,
          status: true,
          return_items: {
            include: {
              product: true
            }
          },
          replacement_items: {
            include: {
              product: true
            }
          }
        }
      })

      return {
        ...updated,
        _saleAdjustment: 'none',
        _stockAdjustment: 'none',
        _replacementStock: 'none',
        _transition: `${prevStatusName} -> ${newStatusName}`
      }
    }, {
      maxWait: 10000,
      timeout: 15000
    })

    res.json(result)
  } catch (e) {
    next(e)
  }
}

exports.approve = async (req, res, next) => {
  try {
    const result = await prismaTransaction.$transaction(async (tx) => approveReturn(tx, {
      id: req.params.id,
      scope: branchWhere(req),
      userId: req.user?.sub,
      resolution: req.body.approved_resolution,
      lines: req.body.lines,
      policy: await getReturnPolicy(tx, req.companyId),
      companyId: req.companyId,
      replacements: req.body.replacements,
    }), { maxWait: 10000, timeout: 15000 })
    res.json(result)
  } catch (e) {
    next(e)
  }
}

exports.complete = async (req, res, next) => {
  try {
    const result = await completeReturn(prismaTransaction, {
      id: req.params.id,
      scope: branchWhere(req),
      userId: req.user?.sub,
      companyId: req.companyId,
      payload: req.body,
    })
    res.json(result)
  } catch (e) {
    next(e)
  }
}
