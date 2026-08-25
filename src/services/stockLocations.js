/**
 * Stock por UBICACIÓN dentro de una sucursal.
 *
 * Niveles: products.stock (espejo empresa) → product_stocks (espejo sucursal)
 * → product_stock_locations (la verdad física). Este archivo es el único que
 * escribe el tercer nivel y el libro append-only `stock_movements`.
 *
 * Todo el stock que entra o sale de una sucursal pasa por `applyStockDelta`
 * (services/bomStock.js), que llama aquí. Los llamadores no eligen ubicación:
 * sale por prioridad de despacho y entra a la de recepción.
 */

const { Prisma } = require('@prisma/client')
const { requireBranchId } = require('./stockAvailability')

/** Orden de despacho: almacén, luego ubicación, luego código (desempate estable). */
const DISPATCH_ORDER = Prisma.sql`w.dispatch_priority, l.dispatch_priority, l.code`

/**
 * Ubicación por defecto de la sucursal. Si la sucursal se creó después de la
 * migración de almacenes, se le arma aquí su bodega — así ni el
 * alta de sucursales ni el seed ni las pruebas tienen que acordarse.
 * @param {boolean} receiving prefiere el almacén marcado como de recepción
 */
async function defaultLocationId(tx, branchId, { receiving = false } = {}) {
  const b = requireBranchId(branchId)
  const preferReceiving = receiving ? Prisma.sql`w.is_receiving DESC,` : Prisma.empty
  const pick = async () => {
    const rows = await tx.$queryRaw`
      SELECT l.id
      FROM stock_locations l
      JOIN warehouses w ON w.id = l.warehouse_id
      WHERE w.branch_id = ${b}::uuid AND w.active AND l.active
      ORDER BY ${preferReceiving} w.is_default DESC, l.is_default DESC, ${DISPATCH_ORDER}
      LIMIT 1
    `
    return rows[0] ? String(rows[0].id) : null
  }

  const found = await pick()
  if (found) return found

  // Lleva el nombre de su sucursal: cada sucursal tiene el suyo y tres almacenes
  // llamados "Principal" no se distinguen en ninguna pantalla.
  await tx.$executeRaw`
    WITH w AS (
      INSERT INTO warehouses (id, branch_id, name, code, kind, is_default, is_receiving, dispatch_priority, active, created_at, updated_at)
      SELECT gen_random_uuid(), ${b}::uuid, 'Bodega ' || br.name, 'PRIN', 'BODEGA', true, true, 10, true, now(), now()
      FROM branches br WHERE br.id = ${b}::uuid
      ON CONFLICT (branch_id, code) DO NOTHING
      RETURNING id
    )
    INSERT INTO stock_locations (id, warehouse_id, code, name, is_default, pickable, dispatch_priority, active, created_at)
    SELECT gen_random_uuid(), w.id, 'GENERAL', 'General', true, true, 10, true, now()
    FROM w
    ON CONFLICT (warehouse_id, code) DO NOTHING
  `
  const created = await pick()
  if (created) return created
  const err = new Error('La sucursal no tiene ninguna ubicación activa donde guardar existencias')
  err.status = 500
  throw err
}

/** Motivos que usan la ubicación de venta de la sucursal (el "TPV"). */
const SALES_REASONS = new Set(['SALE', 'SALE_RETURN'])

/** Ubicación de venta configurada en la sucursal, si sigue activa. */
async function salesLocationId(tx, branchId) {
  const rows = await tx.$queryRaw`
    SELECT l.id
    FROM branches b
    JOIN stock_locations l ON l.id = b.sales_location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    WHERE b.id = ${requireBranchId(branchId)}::uuid AND w.active AND l.active
    LIMIT 1
  `
  return rows[0] ? String(rows[0].id) : null
}

/**
 * Reparte una salida entre las ubicaciones que despachan, por prioridad.
 * Una sola consulta para todos los productos de la operación.
 * @param {Array<[string, number]>} entries [productId, cantidad a sacar]
 * @param {boolean} adjust corrección (merma, conteo, edición manual): empieza por
 *   la ubicación menos accesible y sí puede tocar las que no despachan —
 *   `pickable` frena las ventas, no el corregir lo que hay.
 * @returns {Promise<Array<{ product_id, location_id, qty }>>} qty NEGATIVA
 */
async function planDispatch(
  tx,
  branchId,
  entries,
  { adjust = false, preferLocationId = null, shortfall = null } = {}
) {
  const b = requireBranchId(branchId)
  const ids = entries.map(([id]) => String(id))
  if (ids.length === 0) return []

  const onlyPickable = adjust ? Prisma.empty : Prisma.sql`AND l.pickable`
  // La ubicación del punto de venta va primero; si no alcanza, sigue el resto.
  const order = preferLocationId
    ? Prisma.sql`CASE WHEN l.id = ${preferLocationId}::uuid THEN 0 ELSE 1 END, ${DISPATCH_ORDER}`
    : DISPATCH_ORDER
  const rows = await tx.$queryRaw`
    SELECT psl.product_id, psl.location_id, psl.stock
    FROM product_stock_locations psl
    JOIN stock_locations l ON l.id = psl.location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    WHERE w.branch_id = ${b}::uuid AND w.active AND l.active ${onlyPickable}
      AND psl.stock > 0
      AND psl.product_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY ${order}
  `
  const byProduct = new Map()
  for (const row of rows) {
    const key = String(row.product_id)
    if (!byProduct.has(key)) byProduct.set(key, [])
    byProduct.get(key).push(row)
  }

  const out = []
  for (const [productId, qty] of entries) {
    let pending = Number(qty)
    const available = byProduct.get(String(productId)) || []
    for (const row of adjust ? [...available].reverse() : available) {
      if (pending <= 0) break
      const take = Math.min(pending, Number(row.stock))
      if (take <= 0) continue
      out.push({ product_id: String(productId), location_id: String(row.location_id), qty: -take })
      pending -= take
    }
    if (pending > 0) {
      // Dos situaciones distintas que antes se trataban igual:
      //
      //  - La sucursal TAMPOCO tiene: es una venta autorizada por encima de la
      //    existencia (el mostrador lo permite con clave de administrador). No
      //    es un error de datos: se despacha lo que hay y el resto queda en
      //    negativo en un anaquel, que es la verdad de lo que pasó.
      //  - La sucursal sí tiene pero las ubicaciones no lo juntan: ahí los
      //    espejos están descuadrados y hay que gritar, no "arreglarlo" callado.
      const permitido = shortfall?.allowed.get(String(productId)) || 0
      if (permitido >= pending && shortfall?.locationId) {
        out.push({ product_id: String(productId), location_id: shortfall.locationId, qty: -pending })
        shortfall.used.add(String(productId))
        continue
      }
      const err = new Error(
        `Descuadre de existencias: faltan ${pending} unidades del producto ${productId} en las ubicaciones de la sucursal`
      )
      err.status = 409
      err.code = 'LOCATION_STOCK_MISMATCH'
      throw err
    }
  }
  return out
}

/** Todas las ubicaciones dadas tienen que ser de esta sucursal y estar activas. */
async function assertBranchLocations(tx, branchId, locationIds) {
  const ids = [...new Set((locationIds || []).filter(Boolean).map(String))]
  if (ids.length === 0) return
  const rows = await tx.$queryRaw`
    SELECT l.id FROM stock_locations l
    JOIN warehouses w ON w.id = l.warehouse_id
    WHERE w.branch_id = ${requireBranchId(branchId)}::uuid AND w.active AND l.active
      AND l.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
  `
  if (rows.length !== ids.length) {
    const err = new Error('Una de las ubicaciones no pertenece a esta sucursal (o está inactiva)')
    err.status = 403
    throw err
  }
}

/**
 * De qué ubicaciones salió (o a cuáles entró) una operación ya escrita en el
 * libro. El libro es append-only, así que sirve tanto en la misma transacción
 * que lo escribió como meses después (cancelar un traslado viejo).
 * Con `groupId` se lee UNA operación; por (refType, refId, reason) se leen
 * todas las del documento — sirve si el documento solo pudo hacerla una vez.
 * @returns {Promise<Map<string, Array<{ location_id: string, qty: number }>>>}
 *   qty en positivo, en el orden en que se aplicó.
 */
async function dispatchedByRef(tx, { refType, refId, reason, groupId }) {
  const rows = await tx.stockMovement.findMany({
    where: groupId
      ? { group_id: String(groupId) }
      : { ref_type: String(refType), ref_id: String(refId), reason },
    select: { product_id: true, location_id: true, qty: true },
    orderBy: { created_at: 'asc' },
  })
  const out = new Map()
  for (const r of rows) {
    const key = String(r.product_id)
    if (!out.has(key)) out.set(key, [])
    out.get(key).push({ location_id: String(r.location_id), qty: Math.abs(Number(r.qty)) })
  }
  return out
}

function aggregate(deltas) {
  const map = new Map()
  for (const d of deltas) {
    const key = `${d.product_id}|${d.location_id}`
    map.set(key, (map.get(key) || 0) + Number(d.qty || 0))
  }
  return [...map.entries()]
    .map(([key, qty]) => {
      const [product_id, location_id] = key.split('|')
      return { product_id, location_id, qty }
    })
    .filter((d) => d.qty !== 0)
}

/**
 * Aplica deltas por ubicación y escribe el libro. NO toca product_stocks ni
 * products.stock: de eso sigue encargándose applyStockDelta.
 * @param {Array<{ product_id, location_id, qty }>} deltas qty con signo
 */
async function applyLocationDeltas(tx, deltas, ctx = {}) {
  const rows = aggregate(deltas)
  if (rows.length === 0) return []
  const b = requireBranchId(ctx.branchId)

  const pairs = Prisma.join(
    rows.map((d) => Prisma.sql`(${d.product_id}::uuid, ${d.location_id}::uuid)`)
  )
  await tx.$executeRaw`
    INSERT INTO product_stock_locations (id, product_id, location_id, stock, min_stock)
    SELECT gen_random_uuid(), v.product_id, v.location_id, 0, 0
    FROM (VALUES ${pairs}) AS v(product_id, location_id)
    ON CONFLICT (product_id, location_id) DO NOTHING
  `
  // Bloqueo en orden fijo (ubicación, producto) en todas las rutas: sin deadlocks cruzados.
  await tx.$executeRaw`
    SELECT 1 FROM product_stock_locations
    WHERE (product_id, location_id) IN (${pairs})
    ORDER BY location_id, product_id
    FOR UPDATE
  `

  const values = Prisma.join(
    rows.map((d) => Prisma.sql`(${d.product_id}::uuid, ${d.location_id}::uuid, ${d.qty}::int)`)
  )
  const updated = await tx.$queryRaw`
    WITH v(product_id, location_id, qty) AS (VALUES ${values})
    UPDATE product_stock_locations psl
    SET stock = psl.stock + v.qty
    FROM v
    WHERE psl.product_id = v.product_id AND psl.location_id = v.location_id
    RETURNING psl.product_id, psl.location_id, psl.stock AS balance, v.qty
  `

  const permitidos = ctx.negativosPermitidos || new Set()
  const negative = updated.find(
    (r) => Number(r.balance) < 0 && !permitidos.has(String(r.product_id))
  )
  if (negative) {
    const err = new Error(`Una ubicación quedaría en negativo para el producto ${negative.product_id}`)
    err.status = 409
    err.code = 'LOCATION_STOCK_MISMATCH'
    throw err
  }

  await tx.stockMovement.createMany({
    data: updated.map((r) => ({
      branch_id: b,
      location_id: String(r.location_id),
      product_id: String(r.product_id),
      qty: Number(r.qty),
      balance: Number(r.balance),
      reason: ctx.reason || 'MANUAL_ADJUST',
      ref_type: ctx.refType || null,
      ref_id: ctx.refId || null,
      group_id: ctx.groupId || null,
      notes: ctx.notes || null,
      created_by: ctx.userId || null,
    })),
  })
  return updated
}

/**
 * El delta de sucursal, repartido por ubicación: sale por prioridad de
 * despacho, entra a la ubicación de recepción (o a `ctx.locationId`).
 * @param {Array<[string, number]>} entries [productId, cantidad positiva]
 */
async function applyBranchDelta(tx, entries, branchId, sign, ctx = {}) {
  const b = requireBranchId(branchId)
  // Lo que se vende sale de la ubicación del punto de venta, y lo devuelto
  // vuelve ahí: el mostrador no despacha desde la bodega que más tenga.
  const pos = !ctx.locationId && SALES_REASONS.has(ctx.reason) ? await salesLocationId(tx, b) : null
  let deltas
  let negativosPermitidos = null
  if (sign < 0) {
    // Con ubicación explícita (ajuste de una ubicación concreta) sale de ahí y
    // de ningún otro lado; si no alcanza, applyLocationDeltas lo rechaza.
    if (ctx.locationId) {
      deltas = entries.map(([id, qty]) => ({
        product_id: String(id), location_id: ctx.locationId, qty: -Number(qty),
      }))
    } else {
      // Cuánto de cada producto NO tiene ni siquiera la sucursal: eso es lo que
      // se puede dejar en negativo (venta autorizada por encima de la
      // existencia). El espejo todavía no se actualizó: se lee el valor previo.
      const shortfall = {
        allowed: await branchShortfall(tx, b, entries),
        locationId: pos || (await defaultLocationId(tx, b)),
        used: new Set(),
      }
      deltas = await planDispatch(tx, b, entries, {
        adjust: ctx.adjust, preferLocationId: pos, shortfall,
      })
      if (shortfall.used.size > 0) negativosPermitidos = shortfall.used
    }
  } else {
    const locationId = ctx.locationId || pos || (await defaultLocationId(tx, b, { receiving: true }))
    deltas = entries.map(([id, qty]) => ({
      product_id: String(id),
      location_id: locationId,
      qty: Number(qty),
    }))
    // Entradas que no traen lote propio (ajuste, saldo inicial, carga masiva).
    // Es opt-in a propósito: quien ya crea su lote —ingreso de mercancía,
    // devolución de venta, traslado— NO pasa la bandera y no duplica. Si algún
    // día se olvida en una vía nueva, el resultado es un faltante que el reporte
    // detecta, no un lote fantasma que infla la trazabilidad.
    if (ctx.autoLotForTracked) {
      const { ensureLotForIncrease } = require('./lots')
      for (const [id, qty] of entries) {
        await ensureLotForIncrease(tx, { productId: id, branchId: b, locationId, qty })
      }
    }
  }
  return applyLocationDeltas(tx, deltas, { ...ctx, branchId: b, negativosPermitidos })
}

/**
 * Cuánto de cada producto le falta a la SUCURSAL (no a la ubicación) para
 * cubrir la salida. Mayor que cero significa que se está vendiendo lo que no
 * hay, cosa que el mostrador permite con autorización; cero significa que la
 * sucursal sí lo tiene y si las ubicaciones no lo juntan es un descuadre.
 * @returns {Promise<Map<string, number>>}
 */
async function branchShortfall(tx, branchId, entries) {
  const b = requireBranchId(branchId)
  const ids = entries.map(([id]) => String(id))
  const out = new Map()
  if (ids.length === 0) return out
  const rows = await tx.productStock.findMany({
    where: { branch_id: b, product_id: { in: ids } },
    select: { product_id: true, stock: true },
  })
  const enSucursal = new Map(rows.map((r) => [String(r.product_id), Number(r.stock)]))
  for (const [id, qty] of entries) {
    const falta = Number(qty) - (enSucursal.get(String(id)) ?? 0)
    if (falta > 0) out.set(String(id), falta)
  }
  return out
}

/**
 * Movimiento interno entre dos ubicaciones de la MISMA sucursal, en un solo
 * paso: mover de un anaquel a otro es instantáneo, no hay tránsito que bloquear.
 * No toca product_stocks ni products.stock — el total de la sucursal es idéntico.
 * @param {Array<{ product_id, qty }>} lines
 * @returns {Promise<string>} group_id que agrupa las líneas del movimiento
 */
async function moveBetweenLocations(tx, { branchId, fromLocationId, toLocationId, lines, userId, notes }) {
  const b = requireBranchId(branchId)
  if (!fromLocationId || !toLocationId) {
    const err = new Error('Origen y destino son obligatorios'); err.status = 400; throw err
  }
  if (String(fromLocationId) === String(toLocationId)) {
    const err = new Error('El origen y el destino son la misma ubicación'); err.status = 400; throw err
  }

  const rows = (lines || [])
    .map((l) => ({ product_id: String(l.product_id || ''), qty: Math.floor(Number(l.qty || 0)) }))
    .filter((l) => l.product_id && l.qty > 0)
  if (rows.length === 0) {
    const err = new Error('Indica al menos un producto con cantidad mayor a 0'); err.status = 400; throw err
  }

  await assertBranchLocations(tx, b, [fromLocationId, toLocationId])

  // Se valida antes para poder decir qué falta y cuánto hay, no solo "negativo".
  const have = await tx.productStockLocation.findMany({
    where: { location_id: String(fromLocationId), product_id: { in: rows.map((r) => r.product_id) } },
    select: { product_id: true, stock: true, product: { select: { name: true } } },
  })
  const byProduct = new Map(have.map((h) => [String(h.product_id), h]))
  for (const line of rows) {
    const current = Number(byProduct.get(line.product_id)?.stock || 0)
    if (line.qty > current) {
      const name = byProduct.get(line.product_id)?.product?.name || line.product_id
      const err = new Error(`En el origen solo hay ${current} de ${name}, y se piden ${line.qty}`)
      err.status = 400
      throw err
    }
  }

  const groupId = require('crypto').randomUUID()
  const deltas = rows.flatMap((l) => [
    { product_id: l.product_id, location_id: String(fromLocationId), qty: -l.qty },
    { product_id: l.product_id, location_id: String(toLocationId), qty: l.qty },
  ])
  await applyLocationDeltas(tx, deltas, {
    branchId: b, reason: 'INTERNAL_MOVE', refType: 'internal_move', groupId, userId, notes,
  })

  // Los lotes se mudan con la mercancía: salen FEFO del origen y se recrean en
  // el destino. Advisory (nunca lanza), igual que el resto de la capa de lotes.
  const { consumeLotsFEFO, recreateLotsFromSnapshot } = require('./lots')
  const stockMap = new Map(rows.map((l) => [l.product_id, l.qty]))
  const byLocation = new Map(
    rows.map((l) => [l.product_id, [{ location_id: String(fromLocationId), qty: l.qty }]])
  )
  const moved = await consumeLotsFEFO(tx, stockMap, b, byLocation)
  for (const [productId, snapshot] of moved) {
    const qty = snapshot.reduce((sum, s) => sum + Number(s.qty || 0), 0)
    await recreateLotsFromSnapshot(tx, productId, b, snapshot, qty, String(toLocationId))
  }
  return groupId
}

/**
 * Ubicaciones por debajo de su mínimo interno y de dónde reponerlas. Es otra
 * cosa que la alerta de compra (`product_stocks.min_stock`): aquí no falta
 * mercancía en la sucursal, falta en el anaquel. Sin origen sugerido significa
 * que tampoco hay en otra ubicación — eso sí es asunto del proveedor.
 */
async function replenishmentSuggestions(tx, branchId) {
  const b = requireBranchId(branchId)
  return tx.$queryRaw`
    WITH faltantes AS (
      SELECT psl.product_id, psl.location_id, psl.stock, psl.min_stock,
             psl.min_stock - psl.stock AS missing
      FROM product_stock_locations psl
      JOIN stock_locations l ON l.id = psl.location_id
      JOIN warehouses w ON w.id = l.warehouse_id
      WHERE w.branch_id = ${b}::uuid AND w.active AND l.active
        AND psl.min_stock > 0 AND psl.stock < psl.min_stock
    ),
    origen AS (
      SELECT DISTINCT ON (f.product_id, f.location_id)
             f.product_id, f.location_id,
             o.location_id AS from_location_id, o.stock AS from_stock
      FROM faltantes f
      JOIN product_stock_locations o
        ON o.product_id = f.product_id AND o.location_id <> f.location_id AND o.stock > 0
      JOIN stock_locations lo ON lo.id = o.location_id
      JOIN warehouses wo ON wo.id = lo.warehouse_id
      WHERE wo.branch_id = ${b}::uuid AND wo.active AND lo.active
      -- El anaquel con más existencia: mover de donde sobra es lo que menos estorba.
      ORDER BY f.product_id, f.location_id, o.stock DESC, lo.code
    )
    SELECT f.product_id, p.name AS product_name, p.barcode,
           f.location_id, l.code AS location_code, l.name AS location_name,
           w.name AS warehouse_name,
           f.stock::int, f.min_stock::int, f.missing::int,
           g.from_location_id, fl.code AS from_location_code, fw.name AS from_warehouse_name,
           g.from_stock::int,
           LEAST(f.missing, COALESCE(g.from_stock, 0))::int AS suggested_qty
    FROM faltantes f
    JOIN products p ON p.id = f.product_id AND NOT p.deleted
    JOIN stock_locations l ON l.id = f.location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    LEFT JOIN origen g ON g.product_id = f.product_id AND g.location_id = f.location_id
    LEFT JOIN stock_locations fl ON fl.id = g.from_location_id
    LEFT JOIN warehouses fw ON fw.id = fl.warehouse_id
    ORDER BY f.missing DESC, p.name
  `
}

/** Existencias del producto en la sucursal, sumando sus ubicaciones. */
async function branchLocationStock(tx, productId, branchId) {
  const b = requireBranchId(branchId)
  const rows = await tx.$queryRaw`
    SELECT COALESCE(SUM(psl.stock), 0)::int AS total
    FROM product_stock_locations psl
    JOIN stock_locations l ON l.id = psl.location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    WHERE w.branch_id = ${b}::uuid AND psl.product_id = ${String(productId)}::uuid
  `
  return Number(rows[0]?.total || 0)
}

/** Borra las filas de ubicación del producto en la sucursal (solo si están en 0). */
async function clearBranchLocations(tx, productId, branchId) {
  const b = requireBranchId(branchId)
  await tx.$executeRaw`
    DELETE FROM product_stock_locations psl
    USING stock_locations l, warehouses w
    WHERE psl.location_id = l.id AND l.warehouse_id = w.id
      AND w.branch_id = ${b}::uuid AND psl.product_id = ${String(productId)}::uuid
      AND psl.stock = 0
  `
}

module.exports = {
  defaultLocationId,
  salesLocationId,
  assertBranchLocations,
  dispatchedByRef,
  planDispatch,
  applyLocationDeltas,
  applyBranchDelta,
  moveBetweenLocations,
  replenishmentSuggestions,
  branchLocationStock,
  clearBranchLocations,
}
