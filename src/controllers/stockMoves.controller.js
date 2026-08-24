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
 * Movimientos de existencias dentro de una sucursal:
 *  - internos, de una ubicación a otra (no cambian el total de la sucursal)
 *  - ajustes contra una ubicación concreta (merma, daño, corrección: sí lo cambian)
 * y la consulta del libro, que también sirve de kardex al filtrar por producto.
 */

const { prisma, prismaTransaction } = require('../models/prisma')
const { requireBranch } = require('../middlewares/tenant')
const { moveBetweenLocations, replenishmentSuggestions } = require('../services/stockLocations')
const { deductStockMap, restoreStockMap } = require('../services/bomStock')
const { ensureStockAlertsBatch } = require('../services/stockAlerts')
const { validateControlledLot } = require('../services/lots')

// El pooler de Supabase excede los 5s por defecto en conexiones frías.
const TX_OPTIONS = { maxWait: 10000, timeout: 20000 }

const MOVEMENT_INCLUDE = {
  product: { select: { id: true, name: true, barcode: true } },
  location: {
    select: {
      id: true, code: true, name: true,
      warehouse: { select: { id: true, name: true, code: true } },
    },
  },
  createdBy: { select: { id: true, name: true } },
}

// GET /api/stock/moves — el libro de la sucursal, del más reciente al más viejo.
exports.list = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const { product_id, location_id, group_id, reason, from, to } = req.query
    const take = Math.min(500, Math.max(1, Number(req.query.limit) || 100))

    const where = { branch_id: branchId }
    if (product_id) where.product_id = String(product_id)
    if (location_id) where.location_id = String(location_id)
    if (group_id) where.group_id = String(group_id)
    if (reason) where.reason = String(reason).toUpperCase()
    if (from || to) {
      where.created_at = {}
      if (from) where.created_at.gte = new Date(String(from))
      if (to) where.created_at.lte = new Date(String(to))
    }

    const rows = await prisma.stockMovement.findMany({
      where,
      include: MOVEMENT_INCLUDE,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take,
    })
    res.json(rows)
  } catch (e) { next(e) }
}

// POST /api/stock/moves — mueve mercancía entre dos ubicaciones de la sucursal.
exports.createMove = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const { from_location_id, to_location_id, lines, notes } = req.body || {}

    const groupId = await prismaTransaction.$transaction(
      (tx) => moveBetweenLocations(tx, {
        branchId,
        fromLocationId: from_location_id,
        toLocationId: to_location_id,
        lines,
        userId: req.user?.sub || null,
        notes: notes ? String(notes).trim().slice(0, 300) : null,
      }),
      TX_OPTIONS
    )

    const movements = await prisma.stockMovement.findMany({
      where: { group_id: groupId },
      include: MOVEMENT_INCLUDE,
      orderBy: { qty: 'asc' },
    })
    res.status(201).json({ group_id: groupId, movements })
  } catch (e) { next(e) }
}

// POST /api/stock/adjustments — corrige existencias de UNA ubicación, sin documento.
exports.createAdjustment = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const { location_id, lines, notes } = req.body || {}
    if (!location_id) return res.status(400).json({ message: 'location_id es obligatorio' })

    const rows = (lines || [])
      .map((l) => ({
        product_id: String(l.product_id || ''), qty: Math.floor(Number(l.qty || 0)),
        lot_code: l.lot_code != null ? String(l.lot_code).trim().slice(0, 60) : '',
        expiry_date: l.expiry_date || '',
      }))
      .filter((l) => l.product_id && l.qty !== 0)
    if (rows.length === 0) {
      return res.status(400).json({ message: 'Indica al menos un producto con una diferencia distinta de 0' })
    }

    const owned = await prisma.stockLocation.findFirst({
      where: { id: String(location_id), warehouse: { branch_id: branchId } },
      select: { id: true },
    })
    if (!owned) return res.status(403).json({ message: 'La ubicación no pertenece a esta sucursal' })

    const ctx = {
      reason: 'MANUAL_ADJUST',
      refType: 'adjustment',
      // Un ajuste es una sola operación aunque toque diez productos: el asiento
      // contable y el kardex lo leen por este grupo.
      groupId: require('crypto').randomUUID(),
      locationId: owned.id,
      userId: req.user?.sub || null,
      notes: notes ? String(notes).trim().slice(0, 300) : null,
    }
    const updated = await prismaTransaction.$transaction(async (tx) => {
      const out = []
      const positiveRows = rows.filter((row) => row.qty > 0)
      const products = await tx.product.findMany({
        where: { id: { in: positiveRows.map((row) => row.product_id) }, company_id: req.companyId, deleted: false },
        select: { id: true, name: true, tracks_expiry: true, cost: true },
      })
      const productsById = new Map(products.map((product) => [String(product.id), product]))
      if (products.length !== new Set(positiveRows.map((row) => row.product_id)).size) {
        const error = new Error('Uno de los productos no existe en esta empresa')
        error.status = 400
        throw error
      }
      for (const row of positiveRows) {
        const product = productsById.get(row.product_id)
        validateControlledLot(product, row.lot_code, row.expiry_date)
        const explicit = Boolean(row.lot_code || row.expiry_date)
        out.push(...await restoreStockMap(tx, new Map([[row.product_id, row.qty]]), branchId, {
          ...ctx, lotsManagedExternally: explicit,
        }))
        if (explicit) {
          await tx.productLot.create({
            data: {
              product_id: row.product_id, branch_id: branchId, location_id: owned.id,
              lot_code: row.lot_code || null,
              expiry_date: row.expiry_date ? new Date(row.expiry_date) : null,
              qty_received: row.qty, qty_remaining: row.qty,
              unit_cost: product.cost,
            },
          })
        }
      }
      const downs = new Map(rows.filter((r) => r.qty < 0).map((r) => [r.product_id, -r.qty]))
      if (downs.size) out.push(...await deductStockMap(tx, downs, branchId, ctx))
      await ensureStockAlertsBatch(tx, out, branchId)
      return out
    }, TX_OPTIONS)

    res.status(201).json({ products: updated })
  } catch (e) { next(e) }
}

// GET /api/stock/by-location?product_id= — dónde está lo que hay del producto.
// En vista consolidada recorre todas las sucursales de la empresa, y cada fila
// dice de cuál es: "Central · Bodega · GENERAL".
exports.stockByLocation = async (req, res, next) => {
  try {
    const productId = String(req.query.product_id || '')
    if (!productId) return res.status(400).json({ message: 'product_id es obligatorio' })
    const branchFilter = req.branchId
      ? { branch_id: req.branchId }
      : { branch_id: { in: req.branchIds || [] } }

    const rows = await prisma.productStockLocation.findMany({
      where: { product_id: productId, location: { warehouse: branchFilter } },
      select: {
        stock: true, min_stock: true,
        location: {
          select: {
            id: true, code: true, name: true, pickable: true, active: true,
            warehouse: {
              select: {
                id: true, name: true, code: true, dispatch_priority: true,
                branch: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    })
    rows.sort((a, b) =>
      a.location.warehouse.branch.name.localeCompare(b.location.warehouse.branch.name) ||
      a.location.warehouse.dispatch_priority - b.location.warehouse.dispatch_priority ||
      a.location.code.localeCompare(b.location.code))
    res.json(rows)
  } catch (e) { next(e) }
}

// PUT /api/stock/by-location/min — mínimo interno del anaquel. No es el mínimo
// de compra (ese es de la sucursal): este solo pide mover, no comprar.
exports.setLocationMin = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const { product_id, location_id, min_stock } = req.body || {}
    const min = Math.floor(Number(min_stock))
    if (!product_id || !location_id || !Number.isFinite(min) || min < 0) {
      return res.status(400).json({ message: 'product_id, location_id y min_stock >= 0 son obligatorios' })
    }
    const owned = await prisma.stockLocation.findFirst({
      where: { id: String(location_id), warehouse: { branch_id: branchId } },
      select: { id: true },
    })
    if (!owned) return res.status(403).json({ message: 'La ubicación no pertenece a esta sucursal' })

    const row = await prisma.productStockLocation.upsert({
      where: { product_id_location_id: { product_id: String(product_id), location_id: owned.id } },
      update: { min_stock: min },
      create: { product_id: String(product_id), location_id: owned.id, stock: 0, min_stock: min },
      select: { product_id: true, location_id: true, stock: true, min_stock: true },
    })
    res.json(row)
  } catch (e) { next(e) }
}

// GET /api/stock/replenishment — qué anaquel está por debajo de su mínimo y de
// dónde reponerlo sin comprarle nada al proveedor.
exports.replenishment = async (req, res, next) => {
  try {
    const rows = await replenishmentSuggestions(prisma, requireBranch(req))
    res.json(rows)
  } catch (e) { next(e) }
}
