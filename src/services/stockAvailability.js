/**
 * Disponibilidad de stock POR SUCURSAL: físico (product_stocks) − reservas ACTIVE.
 *
 * Todas las funciones exigen `branchId`; si falta se lanza error en lugar de
 * operar sobre un stock global que ya no existe.
 */

const { prisma } = require('../models/prisma')
const { Prisma } = require('@prisma/client')
const { Decimal, decimal, physicalQuantity, storageQuantity, lockPhysicalProducts } = require('./units/physical')
const { assertPhysicalProducts } = require('./catalogItemRules')
const {isV2,D}=require('./units/commercial')

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
  await lockPhysicalProducts(client, ids, b)
  if(require('./checkoutContext').checkoutEnsuredRows(client,ids,b))return
  await client.$executeRaw`
    INSERT INTO product_stocks (id, product_id, branch_id, stock, min_stock)
    SELECT gen_random_uuid(), p.id, ${b}::uuid, 0, 0
    FROM products p
    WHERE p.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ON CONFLICT (product_id, branch_id) DO NOTHING
  `
  require('./checkoutContext').checkoutEnsuredRows(client,ids,b,true)
}

async function sumActiveReservedQty(tx, productId, branchId) {
  const client = tx || prisma
  const b = requireBranchId(branchId)
  const agg = await client.stockReservation.aggregate({
    where: { product_id: productId, branch_id: b, status: ACTIVE },
    _sum: { qty: true },
  })
  return storageQuantity(decimal(agg._sum.qty))
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
  const cached=require('./checkoutContext').checkoutBranchRows(tx,ids,b)
  if(cached)return cached

  await ensureBranchStockRows(tx, ids, b)
  const rows = await tx.$queryRaw`
    SELECT p.id, ps.stock, ps.min_stock, p.name, p.available_for_sale, p.deleted
    FROM products p
    JOIN product_stocks ps ON ps.product_id = p.id AND ps.branch_id = ${b}::uuid
    WHERE p.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY p.id FOR UPDATE OF ps
  `
  for (const row of rows) {
    out.set(String(row.id), row)
  }
  require('./checkoutContext').checkoutBranchRows(tx,ids,b,rows)
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
  const stock = storageQuantity(decimal(product.branch_stocks[0]?.stock))
  const reserved = await sumActiveReservedQty(client, productId, b)
  return { stock, reserved, available: storageQuantity(Decimal.max(0, decimal(stock).sub(reserved))) }
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

  const cached=require('./checkoutContext').checkoutProducts(client,ids,{branchId:b}),stocks=require('./checkoutContext').checkoutBranchRows(client,ids,b)
  const products = cached&&stocks?ids.map(id=>({id,branch_stocks:[{stock:stocks.get(id).stock}]})):await client.product.findMany({
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
    reservedMap.set(row.product_id, decimal(reservedMap.get(row.product_id)).add(decimal(row.qty)).toFixed())
  }

  const locationMap = new Map()
  if (locationId) {
    const rows = await client.productStockLocation.findMany({
      where: { product_id: { in: ids }, location_id: String(locationId) },
      select: { product_id: true, stock: true },
    })
    for (const row of rows) locationMap.set(row.product_id, decimal(row.stock).toFixed())
  }

  const out = {}
  for (const p of products) {
    const stock = storageQuantity(decimal(p.branch_stocks[0]?.stock))
    const reserved = storageQuantity(decimal(reservedMap.get(p.id)))
    const entry = { stock, reserved, available: storageQuantity(Decimal.max(0, decimal(stock).sub(reserved))) }
    if (locationId) {
      // Sin fila en la ubicación son 0, no "desconocido": el producto existe en
      // la sucursal pero no está en el anaquel de venta.
      const atLocation = storageQuantity(decimal(locationMap.get(p.id)))
      // Las reservas son de sucursal, no de ubicación: descontarlas enteras acá
      // subestimaría. El tope real es lo que hay a mano y lo vendible en total.
      entry.location_stock = atLocation
      entry.location_available = storageQuantity(Decimal.min(atLocation, entry.available))
    }
    out[p.id] = entry
  }
  return out
}

/**
 * Valida disponibilidad agregada por producto (líneas duplicadas).
 * @param {Array<{ product_id: string, qty: number }>} lines
 */
async function assertLinesAvailable(tx, lines, { skipProductIds = [], excludeDocumentId, branchId, companyId,allowArchivedServices=false } = {}) {
  if(lines.some(isV2)||await require('../modules/inventory/units').unitsEnabled(tx,companyId))await require('./units/commercialPhysical').lockCommercialProducts(tx,lines,{companyId,branchId,allowArchivedServices})
  const { expandLinesToStockMap, stockMapToLines } = require('./bomStock')
  const skip = new Set(skipProductIds.map(String))
  const stockMap = await expandLinesToStockMap(tx, lines, {companyId,allowArchivedServices})
  const flatLines = await stockMapToLines(stockMap)

  const byProduct = new Map()
  for (const line of flatLines) {
    const pid = String(line.product_id)
    if (skip.has(pid)) continue
    byProduct.set(pid, decimal(byProduct.get(pid)).add(line.qty).toFixed())
  }

  const productIds = [...byProduct.keys()]
  if (productIds.length === 0) return
  const b = requireBranchId(branchId)

  const locked = await lockProductsForUpdate(tx, productIds, b)
  const availabilityMap = await getAvailabilityBatch(productIds, tx, { excludeDocumentId, branchId: b })

  for (const [productId, requested] of byProduct.entries()) {
    const row = locked.get(productId)
    if (!row || row.deleted) {
      const err = new Error(`Producto no encontrado o eliminado: ${productId}`)
      err.status = 400
      throw err
    }
    const available = decimal(availabilityMap[productId]?.available)
    if (decimal(requested).gt(available)) {
      const reserved = decimal(availabilityMap[productId]?.reserved)
      const stock = decimal(row.stock)
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
  companyId,
  allowArchivedServices=false,
}) {
  const b = requireBranchId(branchId)
  const { loadProductsWithBom } = require('./bomStock')
  if(documentLines.some(isV2)||await require('../modules/inventory/units').unitsEnabled(tx,companyId))await require('./units/commercialPhysical').lockCommercialProducts(tx,documentLines,{companyId,branchId:b,allowArchivedServices})
  const prodMap = await loadProductsWithBom(
    tx,
    documentLines.map((line) => line.product_id),
    {companyId,allowArchivedServices}
  )
  const now = new Date()
  const rows = []

  for (const line of documentLines) {
    const product = prodMap.get(String(line.product_id))
    if (product.kind === 'SERVICE') continue
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
          qty: storageQuantity(physicalQuantity(line.base_qty ?? line.qty,product).mul(comp.qty_per_unit ?? 1)),
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
        qty: storageQuantity(physicalQuantity(line.base_qty ?? line.qty,product)),
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
  if (decimal(consumeQty).gte(reservation.qty)) {
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { status: 'CONSUMED', consumed_at: now },
    })
  } else {
    await tx.stockReservation.update({
      where: { id: reservation.id },
      data: { qty: storageQuantity(decimal(reservation.qty).sub(consumeQty)) },
    })
  }
}

async function consumePartialByDocument(tx, documentId, consumptions, {companyId} = {}) {
  const { loadProductsWithBom } = require('./bomStock')
  const now = new Date()

  for (const { line_id: lineId, qty,base_qty:baseQty } of consumptions) {
    if (!lineId) throw Object.assign(new Error('Partida requerida'),{status:400})

    const line = await tx.commercialDocumentLine.findUnique({
      where: { id: lineId,document_id:documentId,...(companyId ? {document:{branch:{company_id:companyId}}} : {}) },
    })
    if (!line) {
      const err = new Error(`Línea de pedido no encontrada: ${lineId}`)
      err.status = 400
      throw err
    }
    const advanced=isV2(line)
    const exactQty = advanced?require('./units/quantity').parseQuantity(baseQty,{decimals:line.unit_snapshot.baseUnit.decimals}):require('./catalogItemRules').commercialQuantity(qty,line)
    if (line.item_kind==='SERVICE') {
      if (exactQty.gt(D(advanced?line.base_qty:line.qty).sub(advanced?line.base_fulfilled||0:line.qty_fulfilled||0))) throw Object.assign(new Error('Cantidad supera pendiente de prestación'),{status:409})
      await tx.commercialDocumentLine.update({where:{id:lineId},data:advanced?{base_fulfilled:{increment:exactQty},qty_fulfilled:D(line.base_fulfilled||0).add(exactQty).mul(line.qty).div(line.base_qty).toDecimalPlaces(6).toFixed()}:{qty_fulfilled:{increment:exactQty}}})
      continue
    }
    const sellQty=exactQty

    const reservations = await tx.stockReservation.findMany({
      where: { document_id: documentId, document_line_id: lineId, status: ACTIVE },
    })
    if (reservations.length === 0) {
      const err = new Error(`No hay reserva activa para la línea ${lineId}`)
      err.status = 400
      throw err
    }

    const pending = advanced?D(line.base_qty).sub(line.base_fulfilled??0):decimal(line.qty).sub(line.qty_fulfilled ?? 0)
    if (sellQty.gt(pending)) throw Object.assign(new Error('Cantidad a entregar supera pendiente reservado'),{status:400})
    // Las reservas son la asignación física congelada; una edición posterior del BOM no la cambia.
    for (const reservation of reservations) {
      const needQty = sellQty.eq(pending) ? decimal(reservation.qty) : require('./units/quantity').parseQuantity(decimal(reservation.qty).mul(sellQty).div(pending),{allowZero:true})
      await consumeReservationQty(tx, reservation, needQty, now)
    }

    await tx.commercialDocumentLine.update({
      where: { id: lineId },
      data: advanced?{base_fulfilled:{increment:sellQty},qty_fulfilled:D(line.base_fulfilled||0).add(sellQty).mul(line.qty).div(line.base_qty).toDecimalPlaces(6).toFixed()}:{ qty_fulfilled: { increment: storageQuantity(sellQty) } },
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
