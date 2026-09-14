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
 * Almacenes y ubicaciones de la sucursal activa. Todo se resuelve contra
 * `req.branchId`: un almacén de otra sucursal simplemente no existe aquí.
 */

const { prisma } = require('../../models/prisma')
const { requireBranch } = require('../../middlewares/tenant')
const { uniqueCode } = require('../../utils/autoCode')

const KINDS = ['BODEGA', 'SALA_VENTAS', 'VITRINA', 'TRANSITO', 'OTRO']

const LOCATION_SELECT = {
  id: true, warehouse_id: true, code: true, name: true, is_default: true,
  pickable: true, dispatch_priority: true, active: true,
}

const WAREHOUSE_INCLUDE = {
  locations: { select: LOCATION_SELECT, orderBy: [{ dispatch_priority: 'asc' }, { code: 'asc' }] },
}

const bad = (res, message) => res.status(400).json({ message })

function cleanCode(raw, max) {
  return String(raw || '').trim().toUpperCase().slice(0, max)
}

/** El almacén, solo si es de la sucursal activa. */
async function ownWarehouse(req, id) {
  return prisma.warehouse.findFirst({
    where: { id, branch_id: requireBranch(req) },
    select: { id: true, is_default: true },
  })
}

/** La ubicación, solo si su almacén es de la sucursal activa. */
async function ownLocation(req, id) {
  return prisma.stockLocation.findFirst({
    where: { id, warehouse: { branch_id: requireBranch(req) } },
    select: { id: true, warehouse_id: true, is_default: true, warehouse: { select: { branch_id: true } } },
  })
}

/** Unidades guardadas en una ubicación (o en todo un almacén). */
async function unitsIn(where) {
  const agg = await prisma.productStockLocation.aggregate({ where, _sum: { stock: true } })
  return Number(agg._sum.stock || 0)
}

// GET /api/warehouses
exports.list = async (req, res, next) => {
  try {
    // ?branch_id= (o 'all') deja que una pantalla pida los almacenes de otra
    // sucursal sin cambiar el selector global; sin él, los de la activa.
    const allowed = req.branchIds || req.userBranchIds || (req.branchId ? [req.branchId] : [])
    const asked = req.query?.branch_id ? String(req.query.branch_id) : null
    if (asked && asked !== 'all' && !allowed.includes(asked)) {
      return res.status(403).json({ message: 'Sin acceso a esa sucursal' })
    }
    const branchId = asked === 'all' ? null : (asked || req.branchId)
    const where = branchId ? { branch_id: branchId } : { branch_id: { in: allowed } }
    const [rows, branch] = await Promise.all([
      prisma.warehouse.findMany({
        where,
        include: { ...WAREHOUSE_INCLUDE, branch: { select: { id: true, name: true } } },
        orderBy: [{ dispatch_priority: 'asc' }, { name: 'asc' }],
      }),
      branchId
        ? prisma.branch.findUnique({ where: { id: branchId }, select: { sales_location_id: true } })
        : null,
    ])
    // Marca de dónde despacha el punto de venta, para no exponer otra ruta.
    for (const w of rows) {
      for (const l of w.locations) l.is_sales = l.id === branch?.sales_location_id
    }
    res.json(rows)
  } catch (e) { next(e) }
}

// PUT /api/warehouses/locations/:locationId/sales — alterna la ubicación desde
// la que vende esta sucursal. Volver a marcarla la deja sin ubicación fija.
exports.setSalesLocation = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const { locationId } = req.params
    const location = await ownLocation(req, locationId)
    if (!location) return res.status(404).json({ message: 'Ubicación no encontrada' })

    const current = await prisma.branch.findUnique({ where: { id: branchId }, select: { sales_location_id: true } })
    const next_ = current?.sales_location_id === locationId ? null : locationId
    await prisma.branch.update({ where: { id: branchId }, data: { sales_location_id: next_ } })
    res.json({ sales_location_id: next_ })
  } catch (e) { next(e) }
}

// POST /api/warehouses — el primero de la sucursal nace por defecto y de recepción.
exports.create = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const { name, code, kind, dispatch_priority, is_default, is_receiving, notes } = req.body || {}
    if (!name) return bad(res, 'name es obligatorio')
    if (kind && !KINDS.includes(kind)) return bad(res, `kind debe ser uno de: ${KINDS.join(', ')}`)

    const created = await prisma.$transaction(async (tx) => {
      const hermanos = await tx.warehouse.findMany({ where: { branch_id: branchId }, select: { code: true } })
      // Sin código, se saca del nombre: "Sala de ventas" → SALADEVENTAS.
      const finalCode = code ? cleanCode(code, 20) : uniqueCode(name, hermanos.map((w) => w.code), 20)
      const first = hermanos.length === 0
      const wantsDefault = first || Boolean(is_default)
      const wantsReceiving = first || Boolean(is_receiving)
      if (wantsDefault) await tx.warehouse.updateMany({ where: { branch_id: branchId }, data: { is_default: false } })
      if (wantsReceiving) await tx.warehouse.updateMany({ where: { branch_id: branchId }, data: { is_receiving: false } })

      const w = await tx.warehouse.create({
        data: {
          branch_id: branchId,
          name: String(name).trim(),
          code: finalCode,
          kind: kind || 'BODEGA',
          is_default: wantsDefault,
          is_receiving: wantsReceiving,
          dispatch_priority: Number.isFinite(Number(dispatch_priority)) ? Number(dispatch_priority) : 100,
          notes: notes ? String(notes).trim() : null,
        },
      })
      // Un almacén sin ubicaciones no puede guardar nada: nace con la suya.
      await tx.stockLocation.create({
        data: { warehouse_id: w.id, code: 'GENERAL', name: 'General', is_default: true, dispatch_priority: 10 },
      })
      return tx.warehouse.findUnique({ where: { id: w.id }, include: WAREHOUSE_INCLUDE })
    })
    res.status(201).json(created)
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'Ya existe un almacén con ese código en la sucursal' })
    next(e)
  }
}

// PATCH /api/warehouses/:id
exports.update = async (req, res, next) => {
  try {
    const branchId = requireBranch(req)
    const existing = await ownWarehouse(req, req.params.id)
    if (!existing) return res.status(404).json({ message: 'Almacén no encontrado' })

    const { name, kind, dispatch_priority, is_default, is_receiving, active, notes } = req.body || {}
    if (kind && !KINDS.includes(kind)) return bad(res, `kind debe ser uno de: ${KINDS.join(', ')}`)
    if (active === false && existing.is_default) {
      return bad(res, 'Marca otro almacén como predeterminado antes de desactivar este')
    }
    if (active === false && (await unitsIn({ location: { warehouse_id: existing.id } })) !== 0) {
      return bad(res, 'El almacén todavía tiene existencias: muévelas antes de desactivarlo')
    }

    const data = {}
    if (name !== undefined) data.name = String(name).trim()
    if (kind !== undefined) data.kind = kind
    if (notes !== undefined) data.notes = notes ? String(notes).trim() : null
    if (dispatch_priority !== undefined) data.dispatch_priority = Number(dispatch_priority)
    if (active !== undefined) data.active = Boolean(active)

    const updated = await prisma.$transaction(async (tx) => {
      if (is_default) {
        await tx.warehouse.updateMany({ where: { branch_id: branchId }, data: { is_default: false } })
        data.is_default = true
      }
      if (is_receiving) {
        await tx.warehouse.updateMany({ where: { branch_id: branchId }, data: { is_receiving: false } })
        data.is_receiving = true
      }
      await tx.warehouse.update({ where: { id: existing.id }, data })
      return tx.warehouse.findUnique({ where: { id: existing.id }, include: WAREHOUSE_INCLUDE })
    })
    res.json(updated)
  } catch (e) { next(e) }
}

// DELETE /api/warehouses/:id — solo si está vacío y no es el predeterminado.
exports.remove = async (req, res, next) => {
  try {
    const existing = await ownWarehouse(req, req.params.id)
    if (!existing) return res.status(404).json({ message: 'Almacén no encontrado' })
    if (existing.is_default) return bad(res, 'No se puede borrar el almacén predeterminado de la sucursal')
    if ((await unitsIn({ location: { warehouse_id: existing.id } })) !== 0) {
      return bad(res, 'El almacén todavía tiene existencias: muévelas antes de borrarlo')
    }
    const moved = await prisma.stockMovement.count({ where: { location: { warehouse_id: existing.id } } })
    if (moved > 0) {
      return bad(res, 'El almacén tiene historial de movimientos: desactívalo en lugar de borrarlo')
    }

    await prisma.$transaction(async (tx) => {
      await tx.productStockLocation.deleteMany({ where: { location: { warehouse_id: existing.id } } })
      await tx.stockLocation.deleteMany({ where: { warehouse_id: existing.id } })
      await tx.warehouse.delete({ where: { id: existing.id } })
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

// POST /api/warehouses/:id/locations
exports.createLocation = async (req, res, next) => {
  try {
    const warehouse = await ownWarehouse(req, req.params.id)
    if (!warehouse) return res.status(404).json({ message: 'Almacén no encontrado' })

    const { code, name, pickable, dispatch_priority, is_default } = req.body || {}
    if (!code && !name) return bad(res, 'Ponle al menos un nombre a la ubicación')

    const created = await prisma.$transaction(async (tx) => {
      const hermanas = await tx.stockLocation.findMany({
        where: { warehouse_id: warehouse.id }, select: { code: true },
      })
      // Sin código, se saca del nombre: "Anaquel 3" → ANAQUEL3.
      const finalCode = code ? cleanCode(code, 30) : uniqueCode(name, hermanas.map((l) => l.code), 30)
      if (is_default) {
        await tx.stockLocation.updateMany({ where: { warehouse_id: warehouse.id }, data: { is_default: false } })
      }
      return tx.stockLocation.create({
        data: {
          warehouse_id: warehouse.id,
          code: finalCode,
          name: name ? String(name).trim() : null,
          is_default: Boolean(is_default),
          pickable: pickable === undefined ? true : Boolean(pickable),
          dispatch_priority: Number.isFinite(Number(dispatch_priority)) ? Number(dispatch_priority) : 100,
        },
        select: LOCATION_SELECT,
      })
    })
    res.status(201).json(created)
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'Ya existe una ubicación con ese código en el almacén' })
    next(e)
  }
}

// PATCH /api/warehouses/locations/:locationId
exports.updateLocation = async (req, res, next) => {
  try {
    const existing = await ownLocation(req, req.params.locationId)
    if (!existing) return res.status(404).json({ message: 'Ubicación no encontrada' })

    const { name, pickable, dispatch_priority, active, is_default } = req.body || {}
    if (active === false && existing.is_default) {
      return bad(res, 'Marca otra ubicación como predeterminada antes de desactivar esta')
    }
    if (active === false && (await unitsIn({ location_id: existing.id })) !== 0) {
      return bad(res, 'La ubicación todavía tiene existencias: muévelas antes de desactivarla')
    }

    const data = {}
    if (name !== undefined) data.name = name ? String(name).trim() : null
    if (pickable !== undefined) data.pickable = Boolean(pickable)
    if (dispatch_priority !== undefined) data.dispatch_priority = Number(dispatch_priority)
    if (active !== undefined) data.active = Boolean(active)

    const updated = await prisma.$transaction(async (tx) => {
      if (is_default) {
        await tx.stockLocation.updateMany({ where: { warehouse_id: existing.warehouse_id }, data: { is_default: false } })
        data.is_default = true
      }
      return tx.stockLocation.update({ where: { id: existing.id }, data, select: LOCATION_SELECT })
    })
    res.json(updated)
  } catch (e) { next(e) }
}

// DELETE /api/warehouses/locations/:locationId
exports.removeLocation = async (req, res, next) => {
  try {
    const existing = await ownLocation(req, req.params.locationId)
    if (!existing) return res.status(404).json({ message: 'Ubicación no encontrada' })
    if (existing.is_default) return bad(res, 'No se puede borrar la ubicación predeterminada del almacén')
    if ((await unitsIn({ location_id: existing.id })) !== 0) {
      return bad(res, 'La ubicación todavía tiene existencias: muévelas antes de borrarla')
    }
    const moved = await prisma.stockMovement.count({ where: { location_id: existing.id } })
    if (moved > 0) return bad(res, 'La ubicación tiene historial: desactívala en lugar de borrarla')

    await prisma.$transaction(async (tx) => {
      await tx.productStockLocation.deleteMany({ where: { location_id: existing.id } })
      await tx.stockLocation.delete({ where: { id: existing.id } })
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
}
