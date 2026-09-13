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
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const {
  expandLinesToStockMap,
  restoreStockMap,
  deductStockMap,
  getAvailabilityBatchWithKits,
} = require('../../services/bomStock')
const { branchWhere } = require('../../middlewares/tenant')

// El stock de una devolución/cambio se mueve en la sucursal DONDE SE VENDIÓ
// (sale.branch_id), no en la del request.
async function restoreReturnItemsStock(tx, returnItems, branchId, ctx) {
  const stockMap = await expandLinesToStockMap(
    tx,
    returnItems.map((item) => ({ product_id: item.product_id, qty: item.qty_returned }))
  )
  const updatedProducts = await restoreStockMap(tx, stockMap, branchId, { reason: 'SALE_RETURN', ...ctx })
  await ensureStockAlertsBatch(tx, updatedProducts, branchId)
  return updatedProducts
}

/** Descuenta stock de los productos que el cliente se lleva en un cambio (EXCHANGE). */
async function deductReplacementStock(tx, replacementItems, branchId, ctx) {
  const stockMap = await expandLinesToStockMap(
    tx,
    replacementItems.map((item) => ({ product_id: item.product_id, qty: item.qty }))
  )
  const updatedProducts = await deductStockMap(tx, stockMap, branchId, { reason: 'SALE_RETURN', ...ctx })
  await ensureStockAlertsBatch(tx, updatedProducts, branchId)
  return updatedProducts
}

/**
 * Aplica el efecto de una devolución (REFUND) a la venta original: reduce las
 * cantidades vendidas y recalcula total_returned / adjusted_total. En un cambio
 * (EXCHANGE) la venta NO se toca (el cliente cambió mercadería por valor equivalente).
 */
async function applyRefundToSale(tx, currentReturn) {
  for (const returnItem of currentReturn.return_items) {
    const saleItem = await tx.saleItem.findUnique({ where: { id: returnItem.sale_item_id } })
    if (!saleItem) {
      console.warn(`[RETURN PROCESS] SaleItem ${returnItem.sale_item_id} no encontrado`)
      continue
    }
    const newQty = Math.max(0, saleItem.qty - returnItem.qty_returned)
    await tx.saleItem.update({ where: { id: returnItem.sale_item_id }, data: { qty: newQty } })
  }
  const sale = await tx.sale.findUnique({ where: { id: currentReturn.sale_id } })
  if (sale) {
    const newTotalReturned = Number(sale.total_returned || 0) + Number(currentReturn.total_refund)
    const newAdjustedTotal = Number(sale.total) - newTotalReturned
    await tx.sale.update({
      where: { id: currentReturn.sale_id },
      data: { total_returned: newTotalReturned, adjusted_total: newAdjustedTotal },
    })
  }
}

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
    const { status, sale_id } = req.query || {}
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize ?? 50)))

    // Una devolución "vive" en la sucursal de su venta.
    const where = { sale: { ...branchWhere(req) } }

    if (status) {
      where.status = { name: String(status) }
    }

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
        }
      }
    })

    if (!returnRecord) {
      return res.status(404).json({ message: 'Devolución no encontrada' })
    }

    res.json(returnRecord)
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
    const { sale_id: saleIdOrRef, reason, items, notes, type, replacements } = req.body
    const returnType = type === 'EXCHANGE' ? 'EXCHANGE' : 'REFUND'

    if (!saleIdOrRef || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: 'sale_id e items son requeridos. items debe ser un array no vacío.'
      })
    }

    if (returnType === 'EXCHANGE' && (!Array.isArray(replacements) || replacements.length === 0)) {
      return res.status(400).json({
        message: 'Un cambio requiere al menos un producto de reemplazo (replacements).'
      })
    }

    const sale_id = await resolveSaleId(saleIdOrRef, branchWhere(req))
    if (!sale_id) {
      return res.status(404).json({ message: 'Venta no encontrada' })
    }

    const created = await prismaTransaction.$transaction(async (tx) => {
      // 1. Validar que la venta existe y está completada
      const sale = await tx.sale.findFirst({
        where: { id: sale_id, ...branchWhere(req) },
        include: {
          status: true,
          sale_items: {
            include: {
              product: true
            }
          }
        }
      })

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

      // 2. Validar items y calcular totales
      const saleItemsMap = new Map(
        sale.sale_items.map(si => [si.id, si])
      )

      let totalRefund = 0
      const validatedItems = []

      for (const item of items) {
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

        // Verificar que no se devuelva más de lo vendido
        const alreadyReturned = await tx.returnItem.aggregate({
          where: {
            sale_item_id: Number(sale_item_id)
          },
          _sum: {
            qty_returned: true
          }
        })

        const previouslyReturned = alreadyReturned._sum.qty_returned || 0
        const availableToReturn = saleItem.qty - previouslyReturned

        if (qty_returned > availableToReturn) {
          const err = new Error(
            `${saleItem.product.name}: solo se pueden devolver ${availableToReturn} unidades ` +
            `(vendidas: ${saleItem.qty}, ya devueltas: ${previouslyReturned})`
          )
          err.status = 400
          throw err
        }

        const refundAmount = Number(saleItem.price) * Number(qty_returned)
        totalRefund += refundAmount

        validatedItems.push({
          sale_item_id: Number(sale_item_id),
          product_id,
          qty_returned: Number(qty_returned),
          refund_amount: refundAmount,
          reason: item.reason || null
        })
      }

      // 2b. Validar productos de reemplazo (solo cambios) y calcular la diferencia
      const validatedReplacements = []
      let replacementTotal = 0
      if (returnType === 'EXCHANGE') {
        const ids = replacements.map((r) => String(r.product_id))
        const products = await tx.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true }
        })
        const productById = new Map(products.map((p) => [p.id, p]))
        const availability = await getAvailabilityBatchWithKits(ids, tx, sale.branch_id)

        for (const rep of replacements) {
          const product_id = String(rep.product_id || '')
          const qty = Number(rep.qty)
          const unit_price = Number(rep.unit_price)

          if (!product_id || !Number.isFinite(qty) || qty <= 0) {
            const err = new Error('Cada reemplazo debe tener product_id y qty > 0')
            err.status = 400
            throw err
          }
          if (!Number.isFinite(unit_price) || unit_price < 0) {
            const err = new Error('Cada reemplazo debe tener un precio unitario válido')
            err.status = 400
            throw err
          }
          const product = productById.get(product_id)
          if (!product) {
            const err = new Error(`Producto de reemplazo ${product_id} no encontrado`)
            err.status = 400
            throw err
          }
          const available = Number(availability[product_id]?.available ?? 0)
          if (qty > available) {
            const err = new Error(
              `${product.name}: stock insuficiente para el cambio (disponible: ${available}, solicitado: ${qty})`
            )
            err.status = 400
            throw err
          }

          const line_total = unit_price * qty
          replacementTotal += line_total
          validatedReplacements.push({ product_id, qty, unit_price, line_total })
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
          sale_id,
          type: returnType,
          reason: reason || null,
          notes: notes || null,
          total_refund: totalRefund,
          price_difference: priceDifference,
          items_count: validatedItems.length,
          status_id: pendingStatus.id,
          return_date: returnDate
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
    const { status_name, restore_stock } = req.body

    if (!id || !status_name) {
      return res.status(400).json({ message: 'id y status_name son requeridos' })
    }

    // restore_stock es opcional y solo aplica cuando status_name = 'Aprobada'
    // Por defecto es true si no se especifica
    const shouldRestoreStock = status_name === 'Aprobada'
      ? (restore_stock !== undefined ? restore_stock : true)
      : false

    const result = await prismaTransaction.$transaction(async (tx) => {
      // 1. Cargar devolución actual
      const currentReturn = await tx.return.findFirst({
        where: { id, sale: { ...branchWhere(req) } },
        include: {
          sale: { select: { branch_id: true } },
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

      if (!currentReturn) {
        const err = new Error('Devolución no encontrada')
        err.status = 404
        throw err
      }

      // 2. Obtener el nuevo estado
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
      const saleBranchId = currentReturn.sale?.branch_id
      const ledgerCtx = { refType: 'return', refId: String(id), userId: req.user?.sub || null }

      // 3. Validar transición de estados
      if (prevStatusName === 'Completada' || prevStatusName === 'Rechazada') {
        const err = new Error(`No se puede cambiar el estado de una devolución ${prevStatusName}`)
        err.status = 400
        throw err
      }

      // 4. Lógica de procesamiento según transición de estados
      const isCompletingFromApproved = (newStatusName === 'Completada') && prevStatusName === 'Aprobada'
      const isCompletingFromPending = (newStatusName === 'Completada') && prevStatusName === 'Pendiente'
      const isApproving = (newStatusName === 'Aprobada') && prevStatusName === 'Pendiente'


      const isExchange = currentReturn.type === 'EXCHANGE'

      // CASO 1: "Aprobada" -> "Completada". REFUND actualiza la venta (el stock de
      // devueltos ya se restauró al aprobar). EXCHANGE no toca la venta.
      if (isCompletingFromApproved) {
        if (isExchange) {
          console.log(`[EXCHANGE PROCESS] Return ${id}: ${prevStatusName} -> ${newStatusName}. Descontando stock de reemplazos (venta sin cambios)...`)
        } else {
          console.log(`[RETURN PROCESS] Return ${id}: ${prevStatusName} -> ${newStatusName}. Actualizando venta (sin restaurar stock, ya restaurado al aprobar)...`)
          await applyRefundToSale(tx, currentReturn)
        }
      }
      // CASO 2: "Pendiente" -> "Completada" directo. REFUND ajusta la venta;
      // ambos tipos restauran el stock de los productos devueltos.
      else if (isCompletingFromPending) {
        if (isExchange) {
          console.log(`[EXCHANGE PROCESS] Return ${id}: ${prevStatusName} -> ${newStatusName}. Cambio directo (venta sin cambios)...`)
        } else {
          console.log(`[RETURN PROCESS] Return ${id}: ${prevStatusName} -> ${newStatusName}. Procesando devolución...`)
          await applyRefundToSale(tx, currentReturn)
        }

        console.log(`[RETURN STOCK RESTORE] Return ${id}: restaurando stock de devueltos al completar...`)
        const restored = await restoreReturnItemsStock(tx, currentReturn.return_items, saleBranchId, ledgerCtx)
        restored.forEach((p) => console.log(`[RETURN STOCK RESTORE] ${p.name}: stock = ${p.stock}`))
      }

      // Cambios: al completar, descontar el stock de los productos de reemplazo.
      if (isExchange && (isCompletingFromApproved || isCompletingFromPending)) {
        const deducted = await deductReplacementStock(tx, currentReturn.replacement_items, saleBranchId, ledgerCtx)
        deducted.forEach((p) => console.log(`[EXCHANGE STOCK] ${p.name}: stock = ${p.stock}`))
      }

      // CASO 3: Si se aprueba desde "Pendiente", restaurar stock solo si restore_stock es true
      if (isApproving && shouldRestoreStock) {
        console.log(`[RETURN STOCK RESTORE] Return ${id}: ${prevStatusName} -> ${newStatusName}. Restaurando stock solamente...`)
        const updatedProducts = await restoreReturnItemsStock(tx, currentReturn.return_items, saleBranchId, ledgerCtx)
        updatedProducts.forEach((p) => {
          console.log(`[RETURN STOCK RESTORE] ${p.name}: stock restaurado = ${p.stock}`)
        })
        console.log(`[RETURN STOCK RESTORE] Alertas de stock actualizadas`)
      } else if (isApproving && !shouldRestoreStock) {
        console.log(`[RETURN STATUS UPDATE] Return ${id}: ${prevStatusName} -> ${newStatusName}. Stock NO será restaurado (restore_stock=false)`)
      }

      // Get Guatemala time for processed_at
      const nowGtProcessed = DateTime.now().setZone('America/Guatemala');
      const processedDate = DateTime.utc(
        nowGtProcessed.year,
        nowGtProcessed.month,
        nowGtProcessed.day,
        nowGtProcessed.hour,
        nowGtProcessed.minute,
        nowGtProcessed.second,
        nowGtProcessed.millisecond
      ).toJSDate();

      // 5. Actualizar la devolución
      // processed_at se actualiza si se procesa la devolución (actualizar venta) o se restaura stock
      const shouldUpdateProcessedAt = isCompletingFromPending || isCompletingFromApproved || (isApproving && shouldRestoreStock)
      console.log('[RETURN DEBUG] shouldUpdateProcessedAt:', shouldUpdateProcessedAt)
      const updated = await tx.return.update({
        where: { id },
        data: {
          status_id: newStatus.id,
          processed_at: shouldUpdateProcessedAt ? processedDate : (currentReturn.processed_at || (isCompletingFromApproved ? processedDate : undefined))
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
        _saleAdjustment: (!isExchange && (isCompletingFromPending || isCompletingFromApproved)) ? 'sale_updated' : 'none',
        _stockAdjustment: (isCompletingFromPending || (isApproving && shouldRestoreStock)) ? 'stock_restored' : 'none',
        _replacementStock: (isExchange && (isCompletingFromPending || isCompletingFromApproved)) ? 'stock_deducted' : 'none',
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
