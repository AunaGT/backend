/**
 * Kits/combos (BOM): explosión de líneas para stock y disponibilidad.
 */

const { Prisma } = require('@prisma/client')
const { prisma } = require('../models/prisma')

function dbClient(tx) {
  return tx || prisma
}

const BOM_INCLUDE = {
  kit_components: {
    orderBy: { sort_order: 'asc' },
    include: {
      component_product: {
        select: { id: true, name: true, kind: true, deleted: true, available_for_sale: true },
      },
    },
  },
}

function parseKind(raw) {
  const k = raw != null ? String(raw).toUpperCase() : 'STANDARD'
  return k === 'KIT' ? 'KIT' : 'STANDARD'
}

function normalizeBomInput(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row, idx) => ({
      component_product_id: String(row.component_product_id || row.product_id || '').trim(),
      qty_per_unit: Math.max(1, Math.floor(Number(row.qty_per_unit ?? row.qty ?? 1))),
      sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : idx,
    }))
    .filter((row) => row.component_product_id)
}

async function loadProductsWithBom(tx, productIds) {
  const client = dbClient(tx)
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  if (ids.length === 0) return new Map()
  const rows = await client.product.findMany({
    where: { id: { in: ids }, deleted: false },
    select: {
      id: true,
      name: true,
      kind: true,
      stock: true,
      stock_assembled: true,
      kit_components: {
        orderBy: { sort_order: 'asc' },
        select: {
          component_product_id: true,
          qty_per_unit: true,
          component_product: { select: { id: true, name: true, kind: true, deleted: true } },
        },
      },
    },
  })
  return new Map(rows.map((p) => [String(p.id), p]))
}

/**
 * Disponibilidad de kits = mínimo floor(componente.disponible / qty_por_unidad).
 */
function computeKitAvailableFromBom(bomLines, availabilityMap) {
  if (!bomLines?.length) return 0
  let min = Infinity
  for (const line of bomLines) {
    const compId = String(line.component_product_id)
    const need = Math.max(1, Number(line.qty_per_unit || 1))
    const available = Number(availabilityMap[compId]?.available ?? 0)
    min = Math.min(min, Math.floor(available / need))
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0
}

async function getAvailabilityBatchWithKits(productIds, tx, branchId, { locationId = null } = {}) {
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  if (ids.length === 0) return {}

  const prodMap = await loadProductsWithBom(tx, ids)
  const componentIds = new Set()
  for (const p of prodMap.values()) {
    if (p.kind === 'KIT') {
      for (const line of p.kit_components) {
        componentIds.add(String(line.component_product_id))
      }
    }
  }

  const allIds = [...new Set([...ids, ...componentIds])]
  const { getAvailabilityBatch } = require('./stockAvailability')
  const base = await getAvailabilityBatch(allIds, tx, { branchId, locationId })
  const out = { ...base }

  // Un kit sin armar vale lo que alcance su componente más escaso. Para la
  // ubicación se repite el mismo cálculo mirando solo lo que hay ahí.
  const byLocation = locationId
    ? Object.fromEntries(
        Object.entries(base).map(([id, v]) => [id, { ...v, available: v.location_available ?? 0 }])
      )
    : null

  for (const id of ids) {
    const p = prodMap.get(id)
    if (!p || p.kind !== 'KIT' || p.stock_assembled) continue
    const kitAvailable = computeKitAvailableFromBom(p.kit_components, base)
    out[id] = {
      stock: kitAvailable,
      reserved: 0,
      available: kitAvailable,
      is_kit: true,
    }
    if (byLocation) {
      const atLocation = computeKitAvailableFromBom(p.kit_components, byLocation)
      out[id].location_stock = atLocation
      out[id].location_available = atLocation
    }
  }
  return out
}

/**
 * Convierte líneas de venta/pedido a movimientos de stock sobre componentes.
 * @param {Array<{ product_id: string, qty: number }>} lines
 * @returns {Promise<Map<string, number>>}
 */
async function expandLinesToStockMap(tx, lines) {
  const productIds = lines.map((l) => String(l.product_id))
  const prodMap = await loadProductsWithBom(tx, productIds)
  const out = new Map()

  for (const line of lines) {
    const pid = String(line.product_id)
    const qty = Number(line.qty || 0)
    if (!pid || qty <= 0) continue

    const product = prodMap.get(pid)
    if (!product) {
      const err = new Error(`Producto no encontrado: ${pid}`)
      err.status = 400
      throw err
    }

    if (product.kind === 'KIT' && !product.stock_assembled) {
      if (!product.kit_components.length) {
        const err = new Error(`El kit "${product.name}" no tiene componentes configurados`)
        err.status = 400
        throw err
      }
      for (const comp of product.kit_components) {
        if (comp.component_product?.deleted) {
          const err = new Error(`Componente eliminado en kit "${product.name}"`)
          err.status = 400
          throw err
        }
        if (comp.component_product?.kind === 'KIT') {
          const err = new Error(`El kit "${product.name}" no puede incluir otro kit como componente`)
          err.status = 400
          throw err
        }
        const compId = String(comp.component_product_id)
        const compQty = qty * Math.max(1, Number(comp.qty_per_unit || 1))
        out.set(compId, (out.get(compId) || 0) + compQty)
      }
    } else {
      out.set(pid, (out.get(pid) || 0) + qty)
    }
  }
  return out
}

async function stockMapToLines(stockMap) {
  return Array.from(stockMap.entries()).map(([product_id, qty]) => ({ product_id, qty }))
}

/**
 * Aplica un delta de stock por sucursal (+/-) sobre product_stocks y mantiene
 * products.stock como espejo (total de todas las sucursales).
 * Devuelve filas { id, name, stock, min_stock } con los valores DE LA SUCURSAL
 * (para alertas de mínimo por sucursal).
 *
 * `ctx` describe la operación para el libro por ubicación
 * ({ reason, refType, refId, userId, locationId }); ver services/stockLocations.js.
 */
async function applyStockDelta(tx, stockMap, branchId, sign, ctx = {}) {
  const client = dbClient(tx)
  const { requireBranchId, ensureBranchStockRows } = require('./stockAvailability')
  const { applyBranchDelta } = require('./stockLocations')
  const b = requireBranchId(branchId)
  const entries = Array.from(stockMap.entries()).filter(([, qty]) => Number(qty) > 0)
  if (entries.length === 0) return []
  await ensureBranchStockRows(client, entries.map(([id]) => id), b)
  // El mismo delta, repartido por ubicación (y anotado en el kardex).
  await applyBranchDelta(client, entries, b, sign, ctx)
  const values = Prisma.join(
    entries.map(([id, qty]) => Prisma.sql`(${id}::uuid, ${sign * Number(qty)}::int)`)
  )
  return client.$queryRaw`
    WITH v(id, qty) AS (VALUES ${values}),
    upd AS (
      UPDATE product_stocks ps
      SET stock = ps.stock + v.qty
      FROM v
      WHERE ps.product_id = v.id AND ps.branch_id = ${b}::uuid
      RETURNING ps.product_id, ps.stock, ps.min_stock
    ),
    mirror AS (
      UPDATE products p
      SET stock = p.stock + v.qty
      FROM v
      WHERE p.id = v.id
    )
    SELECT u.product_id AS id, p.name, u.stock, u.min_stock
    FROM upd u JOIN products p ON p.id = u.product_id
  `
}

async function deductStockMap(tx, stockMap, branchId, ctx) {
  return applyStockDelta(tx, stockMap, branchId, -1, ctx)
}

async function restoreStockMap(tx, stockMap, branchId, ctx) {
  return applyStockDelta(tx, stockMap, branchId, 1, ctx)
}

/**
 * Cuánto se descuenta de cada componente para armar `qty` unidades de un kit.
 */
function buildComponentDeductionMap(bomLines, qty) {
  const map = new Map()
  for (const line of bomLines) {
    const compId = String(line.component_product_id)
    const need = Math.max(1, Number(line.qty_per_unit || 1)) * qty
    map.set(compId, (map.get(compId) || 0) + need)
  }
  return map
}

/**
 * Arma unidades de un kit ahora mismo EN UNA SUCURSAL: descuenta los
 * componentes de esa sucursal y le da al kit stock propio real ahí
 * (stock_assembled = true). Si se pasa `requestedQty` se arma esa cantidad
 * (limitada al máximo disponible); si no, el máximo.
 */
async function assembleKit(tx, kitProductId, requestedQty, branchId) {
  const client = dbClient(tx)
  const { requireBranchId } = require('./stockAvailability')
  const b = requireBranchId(branchId)
  const kit = await client.product.findFirst({
    where: { id: kitProductId, deleted: false },
    select: {
      id: true,
      name: true,
      kind: true,
      kit_components: {
        select: { component_product_id: true, qty_per_unit: true },
      },
    },
  })
  if (!kit) {
    const err = new Error('Producto no encontrado')
    err.status = 404
    throw err
  }
  if (kit.kind !== 'KIT') {
    const err = new Error(`"${kit.name}" no es un kit`)
    err.status = 400
    throw err
  }
  if (!kit.kit_components.length) {
    const err = new Error(`El kit "${kit.name}" no tiene componentes configurados`)
    err.status = 400
    throw err
  }

  const componentIds = kit.kit_components.map((c) => String(c.component_product_id))
  const { getAvailabilityBatch } = require('./stockAvailability')
  const availabilityMap = await getAvailabilityBatch(componentIds, tx, { branchId: b })
  const maxQty = computeKitAvailableFromBom(kit.kit_components, availabilityMap)
  if (maxQty <= 0) {
    const err = new Error(`No hay stock suficiente de componentes para armar "${kit.name}"`)
    err.status = 400
    throw err
  }
  let qty = maxQty
  if (requestedQty !== undefined) {
    qty = Number(requestedQty)
    if (!Number.isInteger(qty) || qty <= 0) {
      const err = new Error('La cantidad a armar debe ser un entero mayor a 0')
      err.status = 400
      throw err
    }
    if (qty > maxQty) {
      const err = new Error(`Solo se pueden armar ${maxQty} unidades con el stock disponible`)
      err.status = 400
      throw err
    }
  }

  const kitCtx = { reason: 'KIT_ASSEMBLE', refType: 'product', refId: String(kitProductId) }
  const deductionMap = buildComponentDeductionMap(kit.kit_components, qty)
  await deductStockMap(tx, deductionMap, b, kitCtx)

  // Stock propio del kit en esta sucursal (+ espejo global en products.stock)
  const [kitRow] = await restoreStockMap(tx, new Map([[String(kitProductId), qty]]), b, kitCtx)
  const product = await client.product.update({
    where: { id: kitProductId },
    data: { stock_assembled: true },
    select: { id: true, name: true, stock: true, min_stock: true, stock_assembled: true },
  })

  return {
    qty,
    product: {
      ...product,
      // stock/min de la sucursal donde se armó (para alertas y respuesta)
      stock: Number(kitRow?.stock ?? product.stock),
      min_stock: Number(kitRow?.min_stock ?? product.min_stock),
    },
  }
}

async function validateBomComponents(tx, kitProductId, components) {
  const rows = normalizeBomInput(components)
  if (rows.length === 0) {
    const err = new Error('Un kit debe incluir al menos un componente')
    err.status = 400
    throw err
  }

  const kitId = String(kitProductId)
  const seen = new Set()
  for (const row of rows) {
    if (row.component_product_id === kitId) {
      const err = new Error('Un kit no puede incluirse a sí mismo como componente')
      err.status = 400
      throw err
    }
    if (seen.has(row.component_product_id)) {
      const err = new Error('Componente duplicado en el kit')
      err.status = 400
      throw err
    }
    seen.add(row.component_product_id)
  }

  // Los componentes deben ser de la MISMA empresa que el kit
  const kit = await dbClient(tx).product.findUnique({
    where: { id: kitProductId },
    select: { company_id: true },
  })
  if (!kit) {
    const err = new Error('Producto no encontrado')
    err.status = 404
    throw err
  }
  const componentIds = rows.map((r) => r.component_product_id)
  const products = await dbClient(tx).product.findMany({
    where: { id: { in: componentIds }, deleted: false, company_id: kit.company_id },
    select: { id: true, name: true, kind: true },
  })
  const prodMap = new Map(products.map((p) => [String(p.id), p]))

  for (const row of rows) {
    const p = prodMap.get(row.component_product_id)
    if (!p) {
      const err = new Error(`Componente no encontrado: ${row.component_product_id}`)
      err.status = 400
      throw err
    }
    if (p.kind === 'KIT') {
      const err = new Error(`"${p.name}" es un kit; solo productos estándar pueden ser componentes`)
      err.status = 400
      throw err
    }
  }
  return rows
}

async function replaceProductBom(tx, kitProductId, components) {
  const client = dbClient(tx)
  const rows = await validateBomComponents(tx, kitProductId, components)
  await client.productBomLine.deleteMany({ where: { kit_product_id: kitProductId } })
  if (rows.length === 0) return []
  await client.productBomLine.createMany({
    data: rows.map((row) => ({
      kit_product_id: kitProductId,
      component_product_id: row.component_product_id,
      qty_per_unit: row.qty_per_unit,
      sort_order: row.sort_order,
    })),
  })
  return client.productBomLine.findMany({
    where: { kit_product_id: kitProductId },
    orderBy: { sort_order: 'asc' },
    include: {
      component_product: { select: { id: true, name: true, barcode: true, price: true, stock: true } },
    },
  })
}

module.exports = {
  BOM_INCLUDE,
  parseKind,
  normalizeBomInput,
  loadProductsWithBom,
  computeKitAvailableFromBom,
  getAvailabilityBatchWithKits,
  expandLinesToStockMap,
  stockMapToLines,
  deductStockMap,
  restoreStockMap,
  buildComponentDeductionMap,
  assembleKit,
  validateBomComponents,
  replaceProductBom,
}
