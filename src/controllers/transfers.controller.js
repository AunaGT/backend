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
 * Traslados de mercancía entre sucursales de la misma empresa, en dos pasos:
 * envío (resta en origen) → recepción (suma en destino). Lo enviado y no
 * recibido queda registrado como faltante de tránsito y se resuelve por conteo.
 */

const { prisma, prismaTransaction } = require('../models/prisma')
const { requireBranch } = require('../middlewares/tenant')
const { nextDocumentReference } = require('../services/referenceGenerator')
const { deductStockMap, restoreStockMap, expandLinesToStockMap } = require('../services/bomStock')
const { assertLinesAvailable } = require('../services/stockAvailability')
const { ensureStockAlertsBatch } = require('../services/stockAlerts')
const { recreateLotsFromSnapshot } = require('../services/lots')
const { assertBranchLocations, dispatchedByRef, defaultLocationId } = require('../services/stockLocations')

// El pooler de Supabase excede los 5s por defecto en conexiones frías: sin esto
// el envío fallaba "a veces" y funcionaba al reintentar (conexión ya caliente).
const TX_OPTIONS = { maxWait: 10000, timeout: 20000 }

const TRANSFER_INCLUDE = {
  fromBranch: { select: { id: true, name: true, code: true } },
  toBranch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true } },
  receivedBy: { select: { id: true, name: true } },
  lines: {
    include: { product: { select: { id: true, name: true, barcode: true } } },
  },
}

/**
 * GET /api/transfers?direction=in|out|all&status=EN_TRANSITO
 * Por defecto muestra los de la sucursal activa en ambos sentidos.
 */
exports.list = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 25)))
    const { direction = 'all', status } = req.query || {}

    const where = {}
    if (status) where.status = String(status).toUpperCase()

    if (req.branchId) {
      if (direction === 'in') where.to_branch_id = req.branchId
      else if (direction === 'out') where.from_branch_id = req.branchId
      else where.OR = [{ from_branch_id: req.branchId }, { to_branch_id: req.branchId }]
    } else {
      // Vista consolidada: todos los traslados de la empresa
      where.fromBranch = { company_id: req.companyId }
    }

    const totalItems = await prisma.stockTransfer.count({ where })
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
    const safePage = Math.min(page, totalPages)

    const items = await prisma.stockTransfer.findMany({
      where,
      include: TRANSFER_INCLUDE,
      orderBy: { sent_at: 'desc' },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
    })

    res.json({
      items,
      page: safePage,
      pageSize,
      totalPages,
      totalItems,
      nextPage: safePage < totalPages ? safePage + 1 : null,
      prevPage: safePage > 1 ? safePage - 1 : null,
    })
  } catch (e) { next(e) }
}

exports.getById = async (req, res, next) => {
  try {
    const transfer = await prisma.stockTransfer.findFirst({
      where: { id: req.params.id, fromBranch: { company_id: req.companyId } },
      include: TRANSFER_INCLUDE,
    })
    if (!transfer) return res.status(404).json({ message: 'Traslado no encontrado' })
    res.json(transfer)
  } catch (e) { next(e) }
}

/**
 * POST /api/transfers
 * body { to_branch_id, items: [{ product_id, qty }], notes? }
 * Resta el stock del origen (la sucursal activa) y deja el traslado EN_TRANSITO.
 */
exports.create = async (req, res, next) => {
  try {
    const { to_branch_id: toBranchId, items, notes } = req.body || {}
    if (!toBranchId) return res.status(400).json({ message: 'to_branch_id es requerido' })
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'items es requerido' })
    }

    const fromBranchId = requireBranch(req)
    if (toBranchId === fromBranchId) {
      return res.status(400).json({ message: 'El destino debe ser una sucursal distinta' })
    }

    // Agregar cantidades por producto (líneas repetidas del mismo producto)
    const qtyByProduct = new Map()
    for (const it of items) {
      const pid = String(it.product_id || '')
      const qty = Number(it.qty || 0)
      if (!pid || !Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: 'Cada item debe tener product_id y qty entero > 0' })
      }
      qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + qty)
    }
    const productIds = [...qtyByProduct.keys()]

    const created = await prismaTransaction.$transaction(async (tx) => {
      const toBranch = await tx.branch.findFirst({
        where: { id: toBranchId, company_id: req.companyId, active: true },
        select: { id: true },
      })
      if (!toBranch) {
        const err = new Error('La sucursal destino no existe en esta empresa o está inactiva')
        err.status = 400
        throw err
      }

      const products = await tx.product.findMany({
        where: { id: { in: productIds }, deleted: false, company_id: req.companyId },
        select: { id: true, name: true, kind: true, stock_assembled: true },
      })
      if (products.length !== productIds.length) {
        const err = new Error('Uno o más productos no existen en esta empresa')
        err.status = 400
        throw err
      }
      // Un kit virtual no tiene stock propio que trasladar: se trasladan sus componentes
      const virtualKit = products.find((p) => p.kind === 'KIT' && !p.stock_assembled)
      if (virtualKit) {
        const err = new Error(
          `"${virtualKit.name}" es un kit sin stock propio; arma unidades antes de trasladarlo o traslada sus componentes`
        )
        err.status = 400
        throw err
      }

      const lines = productIds.map((pid) => ({ product_id: pid, qty: qtyByProduct.get(pid) }))
      await assertLinesAvailable(tx, lines, { branchId: fromBranchId })

      const branch = await tx.branch.findUnique({
        where: { id: fromBranchId },
        select: { id: true, code: true, seq: true },
      })
      const reference = await nextDocumentReference(tx, 'T', branch)

      const transfer = await tx.stockTransfer.create({
        data: {
          reference,
          from_branch_id: fromBranchId,
          to_branch_id: toBranchId,
          created_by: req.user.sub,
          notes: notes != null ? String(notes).trim() || null : null,
          lines: {
            create: lines.map((l) => ({ product_id: l.product_id, qty_sent: l.qty })),
          },
        },
        include: TRANSFER_INCLUDE,
      })

      // Sale del origen ahora; entra al destino al recibir
      const stockMap = await expandLinesToStockMap(tx, lines)
      const lotSnapshots = new Map()
      const updated = await deductStockMap(tx, stockMap, fromBranchId, {
        reason: 'TRANSFER_OUT', refType: 'transfer', refId: String(transfer.id), userId: req.user.sub,
        lotSnapshots,
      })
      await ensureStockAlertsBatch(tx, updated, fromBranchId)

      for (const line of transfer.lines) {
        const snapshot = lotSnapshots.get(String(line.product_id))
        if (snapshot?.length) {
          await tx.stockTransferLine.update({
            where: { id: line.id },
            data: { lots_snapshot: snapshot },
          })
        }
      }

      return transfer
    }, TX_OPTIONS)

    res.status(201).json(created)
  } catch (e) { next(e) }
}

/**
 * POST /api/transfers/:id/receive
 * body { to_location_id?, lines?: [{ line_id, qty_received, to_location_id? }] }
 * Sin líneas se recibe todo lo enviado; sin ubicación entra a la de recepción
 * del almacén por defecto (lo de siempre). La de la línea gana sobre la general.
 * Suma al destino lo efectivamente recibido; la diferencia queda como faltante.
 */
exports.receive = async (req, res, next) => {
  try {
    const { lines: linesRaw, to_location_id: toLocationId } = req.body || {}
    const branchId = requireBranch(req)

    const result = await prismaTransaction.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id: req.params.id, toBranch: { company_id: req.companyId } },
        include: { lines: true },
      })
      if (!transfer) {
        const err = new Error('Traslado no encontrado')
        err.status = 404
        throw err
      }
      if (transfer.status !== 'EN_TRANSITO') {
        const err = new Error(`El traslado ya está ${transfer.status}`)
        err.status = 400
        throw err
      }
      if (transfer.to_branch_id !== branchId) {
        const err = new Error('Solo la sucursal destino puede recibir este traslado')
        err.status = 403
        throw err
      }

      // Reclamo atómico ANTES de tocar stock: mismo patrón anti-carrera que el
      // cierre de turno de caja (updateMany + count). Sin esto, dos recepciones
      // simultáneas del mismo traslado pasarían ambas el check de arriba y
      // acreditarían el stock por duplicado.
      const claim = await tx.stockTransfer.updateMany({
        where: { id: transfer.id, status: 'EN_TRANSITO' },
        data: { status: 'RECIBIDA', received_by: req.user.sub, received_at: new Date() },
      })
      if (claim.count !== 1) {
        const err = new Error('El traslado ya fue recibido')
        err.status = 409
        throw err
      }

      const receivedByLine = new Map()
      const locationByLine = new Map()
      if (Array.isArray(linesRaw) && linesRaw.length > 0) {
        for (const l of linesRaw) {
          const lineId = String(l.line_id || '')
          const qty = Number(l.qty_received)
          if (!lineId || !Number.isInteger(qty) || qty < 0) {
            const err = new Error('Cada línea debe tener line_id y qty_received entero >= 0')
            err.status = 400
            throw err
          }
          receivedByLine.set(lineId, qty)
          if (l.to_location_id) locationByLine.set(lineId, String(l.to_location_id))
        }
      }
      // Recibir en la ubicación de otra sucursal sería meter mercancía ajena.
      await assertBranchLocations(tx, branchId, [toLocationId, ...locationByLine.values()])

      // Agrupado por ubicación de destino ('' = la de recepción por defecto).
      const byLocation = new Map()
      let receivingLocation = null
      for (const line of transfer.lines) {
        const qty = receivedByLine.has(line.id) ? receivedByLine.get(line.id) : line.qty_sent
        if (qty > line.qty_sent) {
          const err = new Error('No se puede recibir más de lo enviado')
          err.status = 400
          throw err
        }
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { qty_received: qty },
        })
        if (qty > 0) {
          const target = locationByLine.get(line.id) || (toLocationId ? String(toLocationId) : '')
          if (!byLocation.has(target)) byLocation.set(target, new Map())
          const map = byLocation.get(target)
          map.set(String(line.product_id), (map.get(String(line.product_id)) || 0) + qty)
          // Los lotes que viajaron aterrizan donde aterrizó la mercancía.
          if (!target && !receivingLocation) {
            receivingLocation = await defaultLocationId(tx, branchId, { receiving: true })
          }
          await recreateLotsFromSnapshot(
            tx, String(line.product_id), branchId, line.lots_snapshot, qty, target || receivingLocation,
          )
        }
      }

      for (const [target, stockMap] of byLocation) {
        const updated = await restoreStockMap(tx, stockMap, branchId, {
          reason: 'TRANSFER_IN', refType: 'transfer', refId: String(transfer.id),
          userId: req.user?.sub || null, locationId: target || undefined,
          lotsManagedExternally: true,
        })
        await ensureStockAlertsBatch(tx, updated, branchId)
      }

      // El status ya se reclamó arriba; solo falta releer con las relaciones
      // (líneas con qty_received ya actualizado) para la respuesta.
      return tx.stockTransfer.findUnique({
        where: { id: transfer.id },
        include: TRANSFER_INCLUDE,
      })
    }, TX_OPTIONS)

    res.json(result)
  } catch (e) { next(e) }
}

/**
 * POST /api/transfers/:id/cancel
 * Solo desde EN_TRANSITO: devuelve el stock a la sucursal origen.
 */
exports.cancel = async (req, res, next) => {
  try {
    const result = await prismaTransaction.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id: req.params.id, fromBranch: { company_id: req.companyId } },
        include: { lines: true },
      })
      if (!transfer) {
        const err = new Error('Traslado no encontrado')
        err.status = 404
        throw err
      }
      if (transfer.status !== 'EN_TRANSITO') {
        const err = new Error(`Solo se pueden cancelar traslados en tránsito (actual: ${transfer.status})`)
        err.status = 400
        throw err
      }
      if (transfer.from_branch_id !== req.branchId) {
        const err = new Error('Solo la sucursal origen puede cancelar este traslado')
        err.status = 403
        throw err
      }

      // Cada unidad vuelve al anaquel del que salió, según el libro. Traslados
      // viejos (sin libro por ubicación) vuelven a la ubicación por defecto.
      const dispatched = await dispatchedByRef(tx, {
        refType: 'transfer', refId: String(transfer.id), reason: 'TRANSFER_OUT',
      })
      const byLocation = new Map()
      for (const line of transfer.lines) {
        const productId = String(line.product_id)
        const availableLots = (Array.isArray(line.lots_snapshot) ? line.lots_snapshot : [])
          .map((lot) => ({ ...lot, qty: Number(lot.qty) || 0 }))
        const back = dispatched.get(productId)?.length
          ? dispatched.get(productId)
          : [{ location_id: '', qty: line.qty_sent }]
        for (const d of back) {
          const target = d.location_id || await defaultLocationId(tx, transfer.from_branch_id, { receiving: true })
          if (!byLocation.has(target)) byLocation.set(target, new Map())
          const map = byLocation.get(target)
          map.set(productId, (map.get(productId) || 0) + d.qty)
          let left = Number(d.qty)
          const snapshot = []
          for (const lot of availableLots) {
            if (left <= 0) break
            if (lot.qty <= 0 || (lot.location_id && lot.location_id !== target)) continue
            const take = Math.min(left, lot.qty)
            snapshot.push({ ...lot, qty: take })
            lot.qty -= take
            left -= take
          }
          await recreateLotsFromSnapshot(
            tx, productId, transfer.from_branch_id, snapshot, Number(d.qty), target,
          )
        }
      }
      for (const [locationId, stockMap] of byLocation) {
        const updated = await restoreStockMap(tx, stockMap, transfer.from_branch_id, {
          reason: 'TRANSFER_CANCEL', refType: 'transfer', refId: String(transfer.id),
          userId: req.user?.sub || null, locationId: locationId || undefined,
          lotsManagedExternally: true,
        })
        await ensureStockAlertsBatch(tx, updated, transfer.from_branch_id)
      }

      return tx.stockTransfer.update({
        where: { id: transfer.id },
        data: { status: 'CANCELADA', cancelled_at: new Date() },
        include: TRANSFER_INCLUDE,
      })
    }, TX_OPTIONS)

    res.json(result)
  } catch (e) { next(e) }
}

/**
 * GET /api/transfers/in-transit
 * Mercancía enviada y no recibida: no pertenece al stock de ninguna sucursal.
 */
exports.inTransitReport = async (req, res, next) => {
  try {
    const transfers = await prisma.stockTransfer.findMany({
      where: { status: 'EN_TRANSITO', fromBranch: { company_id: req.companyId } },
      include: TRANSFER_INCLUDE,
      orderBy: { sent_at: 'asc' },
    })

    const byProduct = new Map()
    for (const t of transfers) {
      for (const line of t.lines) {
        const key = line.product_id
        if (!byProduct.has(key)) {
          byProduct.set(key, {
            product_id: key,
            name: line.product?.name || key,
            barcode: line.product?.barcode || null,
            qty: 0,
            transfers: [],
          })
        }
        const row = byProduct.get(key)
        row.qty += line.qty_sent
        row.transfers.push({
          transfer_id: t.id,
          reference: t.reference,
          from: t.fromBranch?.name,
          to: t.toBranch?.name,
          sent_at: t.sent_at,
          qty: line.qty_sent,
        })
      }
    }

    res.json({
      products: [...byProduct.values()].sort((a, b) => b.qty - a.qty),
      totalTransfers: transfers.length,
    })
  } catch (e) { next(e) }
}
