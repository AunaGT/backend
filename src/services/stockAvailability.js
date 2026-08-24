/**
 * Disponibilidad de stock POR SUCURSAL: físico (product_stocks) − reservas ACTIVE.
 *
 * Todas las funciones exigen `branchId`; si falta se lanza error en lugar de
 * operar sobre un stock global que ya no existe.
 */

const { prisma } = require('../models/prisma')
const { Prisma } = require('@prisma/client')

const ACTIVE = 'ACTIVE'

function requireBranchId(branchId) {
  if (!branchId) {
    const err = new Error('branchId es obligatorio para operaciones de stock')
    err.status = 500
    throw err
  }
  return String(branchId)
}

/**
 * Upsert perezoso: garantiza que exista la fila product_stocks de cada
 * producto en la sucursal (stock 0 si nunca la tocó).
 */
async function ensureBranchStockRows(tx, productIds, branchId) {
  const client = tx || prisma
  const b = requireBranchId(branchId)
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  if (ids.length === 0) return
  await client.$executeRaw`
    INSERT INTO product_stocks (id, product_id, branch_id, stock, min_stock)
    SELECT gen_random_uuid(), p.id, ${b}::uuid, 0, 0
    FROM products p
    WHERE p.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ON CONFLICT (product_id, branch_id) DO NOTHING
  `
}

async function sumActiveReservedQty(tx, productId, branchId) {
  const client = tx || prisma
  const b = requireBranchId(branchId)
  const agg = await client.stockReservation.aggregate({
    where: { product_id: productId, branch_id: b, status: ACTIVE },
    _sum: { qty: true },
  })
  return Number(agg._sum.qty || 0)
}

async function getProductStockForUpdate(tx, productId, branchId) {
  const rows = await lockProductsForUpdate(tx, [productId], branchId)
  return rows.get(String(productId)) || null
}

/**
 * Bloquea las filas product_stocks de la sucursal en una sola consulta.
 * Solo bloquea la fila de ESTA sucursal: dos sucursales vendiendo el mismo
 * producto no se estorban.
 */
async function lockProductsForUpdate(tx, productIds, branchId) {
  const b = requireBranchId(branchId)
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  const out = new Map()
  if (ids.length === 0) return out

  await ensureBranchStockRows(tx, ids, b)
  const rows = await tx.$queryRaw`
    SELECT p.id, ps.stock, ps.min_stock, p.name, p.available_for_sale, p.deleted
    FROM products p
    JOIN product_stocks ps ON ps.product_id = p.id AND ps.branch_id = ${b}::uuid
    WHERE p.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    FOR UPDATE OF ps
  `
  for (const row of rows) {
    out.set(String(row.id), row)
  }
  return out
}

/**
 * @returns {{ stock: number, reserved: number, available: number }}
 */
async function getAvailability(productId, tx, branchId) {
  const client = tx || prisma
  const b = requireBranchId(branchId)
  const product = await client.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      branch_stocks: { where: { branch_id: b }, select: { stock: true } },
    },
  })
  if (!product) {
    const err = new Error('Producto no encontrado')
    err.status = 404
    throw err
  }
  const stock = Number(product.branch_stocks[0]?.stock || 0)
  const reserved = await sumActiveReservedQty(client, productId, b)
  return { stock, reserved, available: Math.max(0, stock - reserved) }
}

/**
 * Disponibilidad por producto en la sucursal.
 * @param {string|null} locationId si viene, cada entrada trae además
 *   `location_stock`: lo que hay en ESA ubicación. El punto de venta lo usa para
 *   mostrar lo que tiene a mano en vez del total de la sucursal, que suma
 *   almacenes desde los que no despacha directo.
 */
async function getAvailabilityBatch(productIds, tx, { excludeDocumentId, branchId, locationId = null } = {}) {
  const client = tx || prisma
  const b = requireBranchId(branchId)
  const ids = [...new Set(productIds.filter(Boolean))]
  if (ids.length === 0) return {}

  const products = await client.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      branch_stocks: { where: { branch_id: b }, select: { stock: true } },
    },
  })

  const reservationWhere = {
    product_id: { in: ids },
    branch_id: b,
    status: ACTIVE,
  }
  if (excludeDocumentId) {
    reservationWhere.document_id = { not: excludeDocumentId }
  }

  const reservedRows = await client.stockReservation.findMany({
    where: reservationWhere,
    select: { product_id: true, qty: true },
  })
  const reservedMap = new Map()
  for (const row of reservedRows) {
    reservedMap.set(row.product_id, (reservedMap.get(row.product_id) || 0) + Number(row.qty || 0))
  }

  const locationMap = new Map()
  if (locationId) {
    const rows = await client.productStockLocation.findMany({
      where: { product_id: { in: ids }, location_id: String(locationId) },
      select: { product_id: true, stock: true },
    })
    for (const row of rows) locationMap.set(row.product_id, Number(row.stock || 0))
  }

  const out = {}
  for (const p of products) {
    const stock = Number(p.branch_stocks[0]?.stock || 0)
    const reserved = reservedMap.get(p.id) || 0
    const entry = { stock, reserved, available: Math.max(0, stock - reserved) }
    if (locationId) {
      // Sin fila en la ubicación son 0, no "desconocido": el producto existe en
      // la sucursal pero no está en el anaquel de venta.
      const atLocation = locationMap.get(p.id) || 0
      // Las reservas son de sucursal, no de ubicación: descontarlas enteras acá
      // subestimaría. El tope real es lo que hay a mano y lo vendible en total.
      entry.location_stock = atLocation
      entry.location_available = Math.min(atLocation, entry.available)
    }
    out[p.id] = entry
  }
  return out
}

/**
 * Valida disponibilidad agregada por producto (líneas duplicadas).
 * @param {Array<{ product_id: string, qty: number }>} lines
 */
async function assertLinesAvailable(tx, lines, { skipProductIds = [], excludeDocumentId, branchId } = {}) {
  const b = requireBranchId(branchId)
  const { expandLinesToStockMap, stockMapToLines } = require('./bomStock')
  const skip = new Set(skipProductIds.map(String))
  const stockMap = await expandLinesToStockMap(tx, lines)
  const flatLines = await stockMapToLines(stockMap)

  const byProduct = new Map()
  for (const line of flatLines) {
    const pid = String(line.product_id)
    if (skip.has(pid)) continue
    byProduct.set(pid, (byProduct.get(pid) || 0) + Number(line.qty || 0))
  }

  const productIds = [...byProduct.keys()]
  if (productIds.length === 0) return

  const locked = await lockProductsForUpdate(tx, productIds, b)
  const availabilityMap = await getAvailabilityBatch(productIds, tx, { excludeDocumentId, branchId: b })

  for (const [productId, requested] of byProduct.entries()) {
    const row = locked.get(productId)
    if (!row || row.deleted) {
      const err = new Error(`Producto no encontrado o eliminado: ${productId}`)
      err.status = 400
      throw err
    }
    const available = Number(availabilityMap[productId]?.available ?? 0)
    if (requested > available) {
      const reserved = Number(availabilityMap[productId]?.reserved ?? 0)
      const stock = Number(row.stock ?? 0)
      const err = new Error(
        `Stock insuficiente para ${row.name || productId}. Disponible: ${available}${reserved > 0 ? ` (${stock} físico − ${reserved} reservado)` : ''}, solicitado: ${requested}`
      )
      err.status = 400
      err.code = 'INSUFFICIENT_STOCK'
      throw err
    }
  }
}

/**
 * Crea reservas ACTIVE para un pedido confirmado.
 * @param {Array<{ id: string, product_id: string, qty: number }>} documentLines
 */
async function reserveForDocument(tx, {
  documentId,
  documentLines,
  expiresAt,
  createdBy,
  reservationKind = 'ORDER',
  branchId,
}) {
  const b = requireBranchId(branchId)
  const { loadProductsWithBom } = require('./bomStock')
  const prodMap = await loadProductsWithBom(
    tx,
    documentLines.map((line) => line.product_id)
  )
  const now = new Date()
  const rows = []

  for (const line of documentLines) {
    const product = prodMap.get(String(line.product_id))
    if (product?.kind === 'KIT' && !product.stock_assembled) {
      if (!product.kit_components?.length) {
        const err = new Error(`El kit "${product.name}" no tiene componentes configurados`)
        err.status = 400
        throw err
      }
      for (const comp of product.kit_components) {
        rows.push({
          product_id: comp.component_product_id,
          branch_id: b,
          document_id: documentId,
          document_line_id: line.id,
          qty: line.qty * Math.max(1, Number(comp.qty_per_unit || 1)),
          status: ACTIVE,
          reservation_kind: reservationKind,
          expires_at: expiresAt || null,
          created_by: createdBy || null,
          created_at: now,
        })
      }
    } else {
      rows.push({
        product_id: line.product_id,
        branch_id: b,
        document_id: documentId,
        document_line_id: line.id,
        qty: line.qty,
        status: ACTIVE,
        reservation_kind: reservationKind,
        expires_at: expiresAt || null,
        created_by: createdBy || null,
        created_at: now,
      })
    }
  }

  if (rows.length === 0) return []
  await tx.stockReservation.createMany({ data: rows })
  return rows
}

async function releaseByDocument(tx, documentId, { status = 'RELEASED' } = {}) {
  const now = new Date()
  await tx.stockReservation.updateMany({
    where: { document_id: documentId, status: ACTIVE },
    data: {
      status,
      released_at: now,
    },
  })
}

async function consumeByDocument(tx, documentId) {
  const now = new Date()
  await tx.stockReservation.updateMany({
    where: { document_id: documentId, status: ACTIVE },
    data: {
      status: 'CONSUMED',
      consumed_at: now,
    },
  })
}

/**
 * Consume parcialmente reservas por línea (entregas parciales).
 * @param {Array<{ line_id: string, qty: number }>} consumptions
 */
async function consumeReservationQty(tx, reservation, consumeQty, now) {
  if (consumeQty >= reservation.qty) {
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { status: 'CONSUMED', consumed_at: now },
    })
  } else {
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { qty: reservation.qty - consumeQty },
    })
  }
}

async function consumePartialByDocument(tx, documentId, consumptions) {
  const { loadProductsWithBom } = require('./bomStock')
  const now = new Date()

  for (const { line_id: lineId, qty } of consumptions) {
    const sellQty = Number(qty)
    if (!lineId || !Number.isFinite(sellQty) || sellQty <= 0) continue

    const line = await tx.commercialDocumentLine.findUnique({
      where: { id: lineId },
      select: { product_id: true },
    })
    if (!line) {
      const err = new Error(`Línea de pedido no encontrada: ${lineId}`)
      err.status = 400
      throw err
    }

    const reservations = await tx.stockReservation.findMany({
      where: { document_id: documentId, document_line_id: lineId, status: ACTIVE },
    })
    if (reservations.length === 0) {
      const err = new Error(`No hay reserva activa para la línea ${lineId}`)
      err.status = 400
      throw err
    }

    const prodMap = await loadProductsWithBom(tx, [line.product_id])
    const product = prodMap.get(String(line.product_id))

    if (product?.kind === 'KIT' && !product.stock_assembled) {
      if (!product.kit_components?.length) {
        const err = new Error(`El kit "${product.name}" no tiene componentes configurados`)
        err.status = 400
        throw err
      }
      const byProduct = new Map(reservations.map((r) => [String(r.product_id), r]))
      for (const comp of product.kit_components) {
        const compId = String(comp.component_product_id)
        const needQty = sellQty * Math.max(1, Number(comp.qty_per_unit || 1))
        const reservation = byProduct.get(compId)
        if (!reservation) {
          const err = new Error(`No hay reserva activa del componente ${compId} para la línea ${lineId}`)
          err.status = 400
          throw err
        }
        if (needQty > reservation.qty) {
          const err = new Error(
            `Cantidad a entregar (${needQty}) supera reserva del componente (${reservation.qty})`
          )
          err.status = 400
          throw err
        }
        await consumeReservationQty(tx, reservation, needQty, now)
      }
    } else {
      const reservation = reservations[0]
      if (reservations.length > 1) {
        const err = new Error(`Reservas inconsistentes para la línea ${lineId}`)
        err.status = 400
        throw err
      }
      if (sellQty > reservation.qty) {
        const err = new Error(`Cantidad a entregar (${sellQty}) supera reserva (${reservation.qty})`)
        err.status = 400
        throw err
      }
      await consumeReservationQty(tx, reservation, sellQty, now)
    }

    await tx.commercialDocumentLine.update({
      where: { id: lineId },
      data: { qty_fulfilled: { increment: sellQty } },
    })
  }
}

async function hasActiveReservations(tx, documentId) {
  const n = await tx.stockReservation.count({
    where: { document_id: documentId, status: ACTIVE },
  })
  return n > 0
}

module.exports = {
  ACTIVE,
  requireBranchId,
  ensureBranchStockRows,
  getAvailability,
  getAvailabilityBatch,
  assertLinesAvailable,
  reserveForDocument,
  releaseByDocument,
  consumeByDocument,
  consumePartialByDocument,
  hasActiveReservations,
  sumActiveReservedQty,
  getProductStockForUpdate,
  lockProductsForUpdate,
}
