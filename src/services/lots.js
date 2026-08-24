/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

// Consumo/restauración de lotes FEFO (first-expired-first-out).
// Capa ADVISORY: Product.stock sigue siendo la verdad para vender. Un descuadre
// de lotes nunca debe abortar una venta, por eso las funciones de escritura
// atrapan y solo loguean. // ponytail: lotes advisory, se reconcilian por reporte

const crypto = require('crypto')
const { prisma } = require('../models/prisma')

/** Código de lote legible cuando el usuario no ingresa uno: L-YYMMDD-XXXX (sufijo aleatorio). */
function generateLotCode(date = new Date()) {
  const y = String(date.getFullYear()).slice(2)
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase()
  return `L-${y}${m}${d}-${suffix}`
}

/**
 * Reparte una cantidad a consumir entre lotes ya ordenados FEFO.
 * Pura (testeable): no toca la BD.
 * @param {Array<{id: string, qty_remaining: number}>} lots ordenados por caducidad asc
 * @param {number} qty
 * @returns {Array<{lotId: string, take: number}>}
 */
function planConsume(lots, qty) {
  const plan = []
  let left = Number(qty) || 0
  for (const lot of lots) {
    if (left <= 0) break
    const take = Math.min(left, Number(lot.qty_remaining) || 0)
    if (take > 0) {
      plan.push({ lotId: lot.id, take })
      left -= take
    }
  }
  // Si left > 0 los lotes no cubren el stock vendido (stock viejo sin lote): se ignora.
  return plan
}

function planConsumeStrict(lots, qty, context = {}) {
  const plan = planConsume(lots, qty)
  const shortfall = (Number(qty) || 0) - plan.reduce((sum, { take }) => sum + take, 0)
  if (shortfall > 0) {
    const err = new Error(`Los lotes no cubren ${shortfall} unidad(es) del inventario físico`)
    err.status = 409
    err.code = 'LOT_STOCK_MISMATCH'
    err.shortfall = shortfall
    err.productId = context.productId || null
    err.locationId = context.locationId || null
    throw err
  }
  return plan
}

async function createAutomaticLots(tx, branchId, locationDeltas, context = {}) {
  const client = tx || prisma
  return Promise.all(locationDeltas
    .filter(({ qty }) => Number(qty) > 0)
    .map(({ product_id, location_id, qty }) => client.productLot.create({
      data: {
        product_id,
        branch_id: branchId,
        location_id,
        lot_code: generateLotCode().replace('L-', 'AUTO-'),
        qty_received: Number(qty),
        qty_remaining: Number(qty),
        unit_cost: context.unitCost ?? null,
        is_system_generated: true,
      },
    })))
}

async function consumeLotsForLocations(tx, branchId, locationDeltas) {
  if (!tx?.productLot || typeof tx.productLot.findMany !== 'function' || typeof tx.productLot.update !== 'function') {
    const err = new Error('consumeLotsForLocations requiere un cliente de transacción')
    err.code = 'LOT_TRANSACTION_REQUIRED'
    throw err
  }
  const client = tx
  const deltas = locationDeltas.filter(({ qty }) => Number(qty) > 0)
  const consumed = new Map()
  if (!branchId) throw new Error('consumeLotsForLocations requiere branchId')
  if (deltas.length === 0) return consumed

  const lots = await client.productLot.findMany({
    where: {
      branch_id: branchId,
      product_id: { in: [...new Set(deltas.map(({ product_id }) => product_id))] },
      location_id: { in: [...new Set(deltas.map(({ location_id }) => location_id))] },
      qty_remaining: { gt: 0 },
    },
    select: {
      id: true, product_id: true, location_id: true, qty_remaining: true,
      expiry_date: true, received_at: true, lot_code: true, unit_cost: true,
      supplier_id: true, is_system_generated: true,
    },
  })

  const availableLots = lots.map((lot) => ({ ...lot }))
  const lotsById = new Map(lots.map((lot) => [lot.id, lot]))
  const plans = []
  for (const { product_id, location_id, qty } of deltas) {
    const locationLots = availableLots
      .filter((lot) => lot.product_id === product_id && lot.location_id === location_id)
      .sort(fefoSort)
    const plan = planConsumeStrict(locationLots, qty, { productId: product_id, locationId: location_id })
    for (const { lotId, take } of plan) {
      locationLots.find(({ id }) => id === lotId).qty_remaining -= take
    }
    plans.push({ product_id, plan })
  }

  for (const { product_id, plan } of plans) {
    for (const { lotId, take } of plan) {
      await client.productLot.update({
        where: { id: lotId },
        data: { qty_remaining: { decrement: take } },
      })
      const lot = lotsById.get(lotId)
      if (!consumed.has(product_id)) consumed.set(product_id, [])
      consumed.get(product_id).push({
        lot_code: lot.lot_code,
        expiry_date: lot.expiry_date ? new Date(lot.expiry_date).toISOString().slice(0, 10) : null,
        unit_cost: lot.unit_cost != null ? Number(lot.unit_cost) : null,
        supplier_id: lot.supplier_id,
        location_id: lot.location_id,
        is_system_generated: lot.is_system_generated,
        qty: take,
      })
    }
  }
  return consumed
}

/**
 * Reparte una cantidad a devolver entre lotes con espacio (qty_received - qty_remaining),
 * más nuevos primero (caducidad más lejana), que es el inverso del consumo FEFO.
 * @param {Array<{id: string, qty_received: number, qty_remaining: number}>} lots ordenados por caducidad desc
 * @param {number} qty
 * @returns {Array<{lotId: string, give: number}>}
 */
function planRestore(lots, qty) {
  const plan = []
  let left = Number(qty) || 0
  for (const lot of lots) {
    if (left <= 0) break
    const room = (Number(lot.qty_received) || 0) - (Number(lot.qty_remaining) || 0)
    const give = Math.min(left, Math.max(0, room))
    if (give > 0) {
      plan.push({ lotId: lot.id, give })
      left -= give
    }
  }
  return plan
}

/** Ordena por caducidad asc, nulls (sin fecha) al final; desempata por recepción más vieja. */
function fefoSort(a, b) {
  const ax = a.expiry_date ? new Date(a.expiry_date).getTime() : Infinity
  const bx = b.expiry_date ? new Date(b.expiry_date).getTime() : Infinity
  if (ax !== bx) return ax - bx
  return new Date(a.received_at).getTime() - new Date(b.received_at).getTime()
}

/**
 * Descuenta qty_remaining de los lotes, FEFO, para cada producto del stockMap.
 * Best-effort: nunca lanza.
 * @param {object} tx cliente Prisma (transacción o no)
 * @param {Map<string, number>} stockMap product_id -> qty vendida
 * @param {Map<string, Array<{location_id, qty}>>} [byLocation] de qué ubicación
 *   salió cada unidad (ver `dispatchedByRef`). Con esto el FEFO se resuelve
 *   DENTRO de la ubicación que despachó: primero se decide el anaquel, después
 *   el lote. Sin esto, FEFO de toda la sucursal (comportamiento viejo).
 * @returns {Promise<Map<string, Array<object>>>} product_id -> lotes consumidos
 *   [{ lot_code, expiry_date, unit_cost, supplier_id, location_id, qty }], en orden FEFO.
 *   Vacío si algo falló: quien lo use debe tolerarlo (los lotes son advisory).
 */
async function consumeLotsFEFO(tx, stockMap, branchId, byLocation) {
  const consumed = new Map()
  try {
    const client = tx || prisma
    const productIds = Array.from(stockMap.keys())
    if (productIds.length === 0) return consumed
    if (!branchId) {
      console.error('[lots] consumeLotsFEFO sin branchId; omitido')
      return consumed
    }
    const lots = await client.productLot.findMany({
      where: { product_id: { in: productIds }, branch_id: branchId, qty_remaining: { gt: 0 } },
      select: {
        id: true, product_id: true, location_id: true, qty_remaining: true, expiry_date: true,
        received_at: true, lot_code: true, unit_cost: true, supplier_id: true,
      },
    })
    const byId = new Map(lots.map((l) => [l.id, l]))
    for (const [productId, qty] of stockMap.entries()) {
      const productLots = lots.filter((l) => l.product_id === productId)
      const plan = byLocation?.get(productId)?.length
        ? byLocation.get(productId).map((d) => ({
            // Lotes de ese anaquel; los que no tienen ubicación conocida tapan el hueco.
            lots: productLots.filter((l) => !l.location_id || l.location_id === d.location_id),
            qty: d.qty,
          }))
        : [{ lots: productLots, qty }]

      for (const chunk of plan) {
        for (const { lotId, take } of planConsume(chunk.lots.slice().sort(fefoSort), chunk.qty)) {
          await client.productLot.update({
            where: { id: lotId },
            data: { qty_remaining: { decrement: take } },
          })
          const lot = byId.get(lotId)
          lot.qty_remaining -= take // el siguiente anaquel ya no lo vuelve a contar
          if (!consumed.has(productId)) consumed.set(productId, [])
          consumed.get(productId).push({
            lot_code: lot.lot_code,
            expiry_date: lot.expiry_date ? lot.expiry_date.toISOString().slice(0, 10) : null,
            unit_cost: lot.unit_cost != null ? Number(lot.unit_cost) : null,
            supplier_id: lot.supplier_id,
            location_id: lot.location_id,
            qty: take,
          })
        }
      }
    }
  } catch (e) {
    console.error('[lots] consumeLotsFEFO (advisory) falló:', e.message)
  }
  return consumed
}

/**
 * Recrea en `branchId` los lotes que viajaron en un traslado, hasta cubrir
 * `qty` (lo efectivamente recibido puede ser menor a lo enviado). Los lotes se
 * toman en el orden del snapshot, que ya viene FEFO. Best-effort: nunca lanza.
 * @param {Array<object>} snapshot lotes serializados por consumeLotsFEFO
 * @param {string} [locationId] anaquel donde quedan; si no viene, el que traía el snapshot
 */
async function recreateLotsFromSnapshot(tx, productId, branchId, snapshot, qty, locationId) {
  try {
    if (!branchId || !Array.isArray(snapshot) || snapshot.length === 0) return
    const client = tx || prisma
    let left = Number(qty) || 0
    for (const lot of snapshot) {
      if (left <= 0) break
      const take = Math.min(left, Number(lot.qty) || 0)
      if (take <= 0) continue
      left -= take
      await client.productLot.create({
        data: {
          product_id: productId,
          branch_id: branchId,
          location_id: locationId || lot.location_id || null,
          lot_code: lot.lot_code || null,
          expiry_date: lot.expiry_date ? new Date(lot.expiry_date) : null,
          qty_received: take,
          qty_remaining: take,
          unit_cost: lot.unit_cost != null ? lot.unit_cost : null,
          supplier_id: lot.supplier_id || null,
        },
      })
    }
  } catch (e) {
    console.error('[lots] recreateLotsFromSnapshot (advisory) falló:', e.message)
  }
}

/**
 * Devuelve cantidad a los lotes (reversa de venta cancelada), inverso del FEFO.
 * Best-effort: nunca lanza.
 * ponytail: devuelve al lote con espacio, sin mirar la ubicación. Si un día
 * importa, el libro tiene el SALE_RETURN con su location_id para dirigirlo.
 * @param {object} tx cliente Prisma
 * @param {Map<string, number>} stockMap product_id -> qty restaurada
 */
async function restoreLotsFEFO(tx, stockMap, branchId) {
  try {
    const client = tx || prisma
    const productIds = Array.from(stockMap.keys())
    if (productIds.length === 0) return
    if (!branchId) {
      console.error('[lots] restoreLotsFEFO sin branchId; omitido')
      return
    }
    const lots = await client.productLot.findMany({
      where: { product_id: { in: productIds }, branch_id: branchId },
      select: {
        id: true, product_id: true, qty_received: true, qty_remaining: true,
        expiry_date: true, received_at: true,
      },
    })
    for (const [productId, qty] of stockMap.entries()) {
      const productLots = lots
        .filter((l) => l.product_id === productId)
        .sort((a, b) => fefoSort(b, a)) // más nuevos primero
      for (const { lotId, give } of planRestore(productLots, qty)) {
        await client.productLot.update({
          where: { id: lotId },
          data: { qty_remaining: { increment: give } },
        })
      }
    }
  } catch (e) {
    console.error('[lots] restoreLotsFEFO (advisory) falló:', e.message)
  }
}

const LOT_ALERT_WINDOW_DAYS = 30
const LOT_ALERT_SYNC_THROTTLE_MS = 10 * 60 * 1000 // 10 min; se dispara al listar alertas (serverless, sin cron)
let lastLotAlertSyncAt = 0

/**
 * Sincroniza alertas de tipo "Vencimiento": una alerta activa por producto con
 * lotes por vencer (<= LOT_ALERT_WINDOW_DAYS) o ya vencidos; resuelve la alerta
 * si el producto deja de calificar. Advisory: nunca lanza, y se auto-throttlea
 * porque puede dispararse en cada GET /alerts (no hay cron en serverless).
 * @param {object} tx cliente Prisma
 * @param {{ force?: boolean }} [opts] force ignora el throttle (ej. al registrar mercancía con lotes)
 */
async function syncLotExpiryAlerts(tx, opts = {}) {
  const client = tx || prisma
  const now = Date.now()
  if (!opts.force && now - lastLotAlertSyncAt < LOT_ALERT_SYNC_THROTTLE_MS) return
  lastLotAlertSyncAt = now

  try {
    const [statusActive, statusResolved, alertType, priorities] = await Promise.all([
      client.status.findFirst({ where: { name: 'Activa' } }),
      client.status.findFirst({ where: { name: 'Resuelta' } }),
      client.alertType.findFirst({ where: { name: 'Vencimiento' } }),
      client.alertPriority.findMany(),
    ])
    if (!statusActive || !statusResolved || !alertType) return
    const priorityByName = Object.fromEntries(priorities.map((p) => [p.name, p]))

    const today = new Date(new Date().toISOString().slice(0, 10))
    const limit = new Date(today.getTime() + LOT_ALERT_WINDOW_DAYS * 86400000)

    const lots = await client.productLot.findMany({
      where: { qty_remaining: { gt: 0 }, expiry_date: { lte: limit } },
      select: {
        product_id: true, branch_id: true, lot_code: true, expiry_date: true, qty_remaining: true,
        product: { select: { name: true } },
        location: { select: { code: true } },
      },
      orderBy: { expiry_date: 'asc' },
    })

    // Clave por producto+sucursal: las alertas de vencimiento son por sucursal
    const keyOf = (productId, branchId) => `${productId}|${branchId}`
    const qualifyingKeys = [...new Set(lots.map((l) => keyOf(l.product_id, l.branch_id)))]
    const qualifyingSet = new Set(qualifyingKeys)

    // Resolver alertas de "Vencimiento" cuyo (producto, sucursal) ya no califica
    const activeExpiryAlerts = await client.alert.findMany({
      where: { type_id: alertType.id, status_id: statusActive.id, resolved: 0 },
      select: { id: true, product_id: true, branch_id: true },
    })
    const toResolve = activeExpiryAlerts
      .filter((a) => !qualifyingSet.has(keyOf(a.product_id, a.branch_id)))
      .map((a) => a.id)
    if (toResolve.length > 0) {
      await client.alert.updateMany({
        where: { id: { in: toResolve } },
        data: { status_id: statusResolved.id, resolved: 1 },
      })
    }

    if (qualifyingKeys.length === 0) return

    const existingByKey = new Map(
      activeExpiryAlerts.map((a) => [keyOf(a.product_id, a.branch_id), a.id])
    )
    const timestamp = new Date()
    const createData = []
    const updates = []

    for (const key of qualifyingKeys) {
      const [productId, branchId] = key.split('|')
      const productLots = lots.filter((l) => l.product_id === productId && l.branch_id === branchId)
      const nearest = productLots[0] // ya viene ordenado por expiry_date asc
      const days = Math.round((new Date(nearest.expiry_date).getTime() - today.getTime()) / 86400000)
      const expired = days < 0
      const priorityName = expired ? 'Crítica' : days <= 7 ? 'Alta' : 'Media'
      const priority = priorityByName[priorityName]
      const extra = productLots.length > 1 ? ` (+${productLots.length - 1} lote${productLots.length > 2 ? 's' : ''} más)` : ''
      // Dónde está lo que vence: sin esto hay que buscarlo anaquel por anaquel.
      const where = nearest.location?.code ? ` en ${nearest.location.code}` : ''

      const alertData = {
        title: expired ? 'Lote vencido' : 'Lote por vencer',
        message: expired
          ? `El lote ${nearest.lot_code || 's/n'} de "${nearest.product.name}" venció hace ${Math.abs(days)} día(s) (${nearest.qty_remaining} unidades${where})${extra}.`
          : `El lote ${nearest.lot_code || 's/n'} de "${nearest.product.name}" vence en ${days} día(s) (${nearest.qty_remaining} unidades${where})${extra}.`,
        timestamp,
        priority_id: priority?.id,
        type_id: alertType.id,
      }

      const existingId = existingByKey.get(key)
      if (existingId) {
        updates.push(client.alert.update({ where: { id: existingId }, data: alertData }))
      } else {
        createData.push({
          product_id: productId,
          branch_id: branchId,
          ...alertData,
          status_id: statusActive.id,
          assigned_to: null,
          resolved: 0,
        })
      }
    }

    const ops = [...updates]
    if (createData.length > 0) ops.push(client.alert.createMany({ data: createData, skipDuplicates: true }))
    await Promise.all(ops)
  } catch (e) {
    console.error('[lots] syncLotExpiryAlerts (advisory) falló:', e.message)
  }
}

module.exports = {
  planConsume, planConsumeStrict, planRestore, fefoSort,
  createAutomaticLots, consumeLotsForLocations,
  consumeLotsFEFO, restoreLotsFEFO, generateLotCode,
  recreateLotsFromSnapshot,
  syncLotExpiryAlerts,
}
