/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * Inventariado: sesiones de conteo físico y ajuste de stock tras aprobación.
 */

const { prisma } = require('../../models/prisma')
const { prismaTransaction } = require('../../models/prisma')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')

function userId(req) {
  return req.user?.sub || req.user?.id
}

const MIN_REASON_LEN = 5

/** Lo que la UI necesita de cada línea, incluida la ubicación que se cuenta. */
const LINE_INCLUDE = {
  product: {
    select: {
      id: true,
      name: true,
      barcode: true,
      stock: true,
      cost: true,
      category: { select: { id: true, name: true } },
    },
  },
  location: {
    select: { id: true, code: true, name: true, warehouse: { select: { id: true, name: true, code: true } } },
  },
  countedBy: { select: { id: true, name: true } },
  countedSecondaryBy: { select: { id: true, name: true } },
}

/** Transacciones interactivas: el default de Prisma (~5s) puede fallar con P2028 al aplicar muchas líneas. */
const INVENTORY_APPROVE_TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 }

function sanitizeScope(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  if (Array.isArray(raw.categoryIds) && raw.categoryIds.length) {
    out.categoryIds = raw.categoryIds.map((x) => Number(x)).filter((x) => Number.isFinite(x))
  }
  if (Array.isArray(raw.supplierIds) && raw.supplierIds.length) {
    out.supplierIds = raw.supplierIds.map(String).filter(Boolean)
  }
  if (Array.isArray(raw.abcClasses) && raw.abcClasses.length) {
    const allowed = new Set(['A', 'B', 'C'])
    out.abcClasses = [
      ...new Set(
        raw.abcClasses.map((x) => String(x).toUpperCase()).filter((x) => allowed.has(x))
      ),
    ]
    if (out.abcClasses.length === 0) delete out.abcClasses
  }
  const sp = Number(raw.samplePercent)
  if (Number.isFinite(sp) && sp > 0 && sp < 100) {
    out.samplePercent = Math.round(sp)
  }
  if (raw.doubleCount === true) out.doubleCount = true
  return out
}

function scopeDoubleCount(scope) {
  return Boolean(scope && typeof scope === 'object' && scope.doubleCount === true)
}

function scopeSamplePercent(scope) {
  if (!scope || typeof scope !== 'object') return null
  const n = Number(scope.samplePercent)
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null
  return Math.round(n)
}

function scopeAbcClasses(scope) {
  if (!scope || typeof scope !== 'object' || !Array.isArray(scope.abcClasses)) return null
  const allowed = new Set(['A', 'B', 'C'])
  const out = [...new Set(scope.abcClasses.map((x) => String(x).toUpperCase()).filter((x) => allowed.has(x)))]
  return out.length ? out : null
}

function assignAbcByInventoryValue(rows) {
  const enriched = rows.map((r) => ({
    id: r.id,
    stock: r.stock,
    cost: r.cost,
    category_id: r.category_id,
    value: Math.max(0, Number(r.stock) || 0) * Number(r.cost || 0),
  }))
  const sorted = [...enriched].sort((a, b) => b.value - a.value)
  const totalVal = sorted.reduce((s, r) => s + r.value, 0)
  if (totalVal <= 0) {
    const n = sorted.length
    if (!n) return []
    const iA = Math.max(1, Math.ceil(n / 3))
    const iB = Math.max(iA + 1, Math.ceil((2 * n) / 3))
    return sorted.map((r, i) => ({
      id: r.id,
      stock: r.stock,
      cost: r.cost,
      category_id: r.category_id,
      abc: i < iA ? 'A' : i < iB ? 'B' : 'C',
    }))
  }
  let cum = 0
  return sorted.map((r) => {
    cum += r.value
    const pct = (100 * cum) / totalVal
    const abc = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C'
    return {
      id: r.id,
      stock: r.stock,
      cost: r.cost,
      category_id: r.category_id,
      abc,
    }
  })
}

function mulberry32(a) {
  return function mul() {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  }
  return h >>> 0
}

function seededShuffleIds(ids, seedStr) {
  const rnd = mulberry32(hashSeed(seedStr))
  const a = [...ids]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

async function resolveProductsForCountStart(session, companyId) {
  const scope = session.scope_json || {}
  const where = buildProductWhereFromScope(scope)
  if (companyId) where.company_id = companyId
  const rows = await prisma.product.findMany({
    where,
    select: { id: true, cost: true, category_id: true },
  })
  // El snapshot es el stock de LA SUCURSAL de la sesión, no el espejo global
  const branchRows = await prisma.productStock.findMany({
    where: { branch_id: session.branch_id, product_id: { in: rows.map((p) => p.id) } },
    select: { product_id: true, stock: true },
  })
  const stockByProduct = new Map(branchRows.map((r) => [r.product_id, r.stock]))
  let list = rows.map((p) => ({ ...p, stock: stockByProduct.get(p.id) ?? 0 }))
  const abc = scopeAbcClasses(scope)
  if (abc) {
    const tagged = assignAbcByInventoryValue(list)
    const allow = new Set(abc)
    list = tagged.filter((t) => allow.has(t.abc)).map((t) => ({
      id: t.id,
      stock: t.stock,
      cost: t.cost,
      category_id: t.category_id,
    }))
  }
  const pct = scopeSamplePercent(scope)
  if (pct != null && list.length > 0) {
    const shuffled = seededShuffleIds(
      list.map((p) => p.id),
      session.id
    )
    const k = Math.max(1, Math.ceil((list.length * pct) / 100))
    const pick = new Set(shuffled.slice(0, k))
    list = list.filter((p) => pick.has(p.id))
  }
  return list.map((p) => ({ id: p.id, stock: p.stock }))
}

function buildProductWhereFromScope(scope) {
  const s = scope && typeof scope === 'object' ? scope : {}
  const where = { deleted: false }
  const and = []
  if (Array.isArray(s.categoryIds) && s.categoryIds.length) {
    and.push({ category_id: { in: s.categoryIds.map((id) => Number(id)) } })
  }
  if (Array.isArray(s.supplierIds) && s.supplierIds.length) {
    and.push({ supplier_id: { in: s.supplierIds.map(String) } })
  }
  if (and.length) where.AND = and
  return where
}

async function assertNoBlockingSession(exceptId, branchId) {
  const blocking = await prisma.inventoryCountSession.findFirst({
    where: {
      status: { in: ['IN_PROGRESS', 'IN_REVIEW', 'PENDING_SECOND_APPROVAL'] },
      ...(branchId ? { branch_id: branchId } : {}),
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true, name: true, status: true },
  })
  if (blocking) {
    const err = new Error(
      `Ya existe un inventariado activo (${blocking.status}). Cierre o cancele la sesión ${blocking.name || blocking.id} antes de iniciar otro.`
    )
    err.statusCode = 409
    throw err
  }
}

/**
 * Ubicaciones que entran en el conteo: las del almacén elegido, o todas las de
 * la sucursal. Si la sucursal aún no tiene ninguna, se le arma la de siempre.
 */
async function countScopeLocations(session) {
  const where = { active: true, warehouse: { branch_id: session.branch_id, active: true } }
  if (session.warehouse_id) where.warehouse.id = session.warehouse_id
  const rows = await prisma.stockLocation.findMany({
    where,
    select: { id: true, is_default: true, warehouse: { select: { is_default: true } } },
    orderBy: [{ dispatch_priority: 'asc' }, { code: 'asc' }],
  })
  if (rows.length) return rows
  const { defaultLocationId } = require('../../services/stockLocations')
  const id = await prisma.$transaction((tx) => defaultLocationId(tx, session.branch_id))
  return [{ id, is_default: true, warehouse: { is_default: true } }]
}

/**
 * Aplica qty_counted al stock de productos dentro de una transacción.
 * La diferencia se aplica en LA UBICACIÓN de cada línea: lo que sobra en un
 * anaquel y falta en otro deja de verse como descuadre de la sucursal.
 * @returns {Promise<string[]>} IDs de productos afectados
 */
async function applyStockTransaction(tx, sessionId, branchId) {
  const lines = await tx.inventoryCountLine.findMany({
    where: { session_id: sessionId, qty_counted: { not: null } },
    include: { product: { select: { min_stock: true, kind: true, stock_assembled: true } } },
  })
  const statuses = await tx.stockStatus.findMany()
  const byName = Object.fromEntries(statuses.map((s) => [s.name, s.id]))
  const idDisponible = byName.Disponible
  const idBajo = byName.Bajo
  const idAgotado = byName.Agotado
  if (!idDisponible) {
    const err = new Error('Catálogo stock_statuses incompleto (falta Disponible)')
    err.statusCode = 500
    throw err
  }

  const { ensureBranchStockRows } = require('../../services/stockAvailability')
  const { deductStockMap, restoreStockMap } = require('../../services/bomStock')
  const productIds = [...new Set(lines.map((l) => l.product_id))]
  await ensureBranchStockRows(tx, productIds, branchId)

  // Lo contado se compara contra lo que hay AHORA en esa ubicación, no contra
  // el snapshot: si algo salió mientras se contaba, el conteo no lo revive.
  const current = await tx.productStockLocation.findMany({
    where: {
      product_id: { in: productIds },
      location_id: { in: [...new Set(lines.map((l) => l.location_id))] },
    },
    select: { product_id: true, location_id: true, stock: true },
  })
  const stockAt = new Map(current.map((r) => [`${r.product_id}|${r.location_id}`, Number(r.stock)]))

  const ups = new Map() // location_id → Map(product_id, unidades que faltan)
  const downs = new Map()
  for (const L of lines) {
    const isVirtualKit = L.product.kind === 'KIT' && !L.product.stock_assembled
    const target = isVirtualKit ? 0 : Number(L.qty_counted)
    const delta = target - (stockAt.get(`${L.product_id}|${L.location_id}`) ?? 0)
    if (delta === 0) continue
    const bucket = delta > 0 ? ups : downs
    if (!bucket.has(L.location_id)) bucket.set(L.location_id, new Map())
    bucket.get(L.location_id).set(String(L.product_id), Math.abs(delta))
  }

  // El grupo hace que el cierre del conteo sea UN asiento contable, no uno por
  // producto ajustado.
  const countCtx = {
    reason: 'COUNT_ADJUST', refType: 'inventory_count', refId: String(sessionId),
    groupId: require('crypto').randomUUID(),
  }
  for (const [location_id, map] of ups) {
    await restoreStockMap(tx, map, branchId, { ...countCtx, locationId: location_id })
  }
  for (const [location_id, map] of downs) {
    await deductStockMap(tx, map, branchId, { ...countCtx, locationId: location_id })
  }

  // El estado del producto mira el total de la sucursal ya ajustado.
  const virtualKits = new Set(
    lines.filter((L) => L.product.kind === 'KIT' && !L.product.stock_assembled).map((L) => L.product_id)
  )
  const minByProduct = new Map(lines.map((L) => [L.product_id, Number(L.product.min_stock) || 0]))
  const after = await tx.productStock.findMany({
    where: { branch_id: branchId, product_id: { in: productIds } },
    select: { product_id: true, stock: true },
  })
  await Promise.all(
    after
      .filter((r) => !virtualKits.has(r.product_id))
      .map((r) => {
        const stock = Number(r.stock)
        let status_id = idDisponible
        if (stock === 0 && idAgotado) status_id = idAgotado
        else if (stock < (minByProduct.get(r.product_id) || 0) && idBajo) status_id = idBajo
        return tx.product.update({ where: { id: r.product_id }, data: { status_id } })
      })
  )

  return productIds
}

const sessionIncludeSummary = {
  warehouse: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  approvedBy: { select: { id: true, name: true, email: true } },
  firstApprovedBy: { select: { id: true, name: true, email: true } },
  _count: { select: { lines: true } },
}

/**
 * GET /inventory-counts
 */
exports.list = async (req, res, next) => {
  try {
    const status = req.query.status
    const take = Math.min(Number(req.query.limit) || 50, 100)
    const skip = Number(req.query.offset) || 0
    const { branchWhere } = require('../../middlewares/tenant')
    const where = { ...branchWhere(req) }
    if (status && String(status).trim()) {
      where.status = String(status).toUpperCase()
    }
    const [rows, total] = await Promise.all([
      prisma.inventoryCountSession.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take,
        skip,
        include: sessionIncludeSummary,
      }),
      prisma.inventoryCountSession.count({ where }),
    ])

    const withProgress = await Promise.all(
      rows.map(async (s) => {
        const dc = scopeDoubleCount(s.scope_json)
        const counted = await prisma.inventoryCountLine.count({
          where: {
            session_id: s.id,
            qty_counted: { not: null },
            ...(dc ? { qty_counted_secondary: { not: null } } : {}),
          },
        })
        return {
          ...s,
          progress: {
            totalLines: s._count.lines,
            countedLines: counted,
            pct: s._count.lines ? Math.round((100 * counted) / s._count.lines) : 0,
          },
        }
      })
    )

    res.json({ data: withProgress, total, take, skip })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /inventory-counts/:id
 */
exports.getById = async (req, res, next) => {
  try {
    const { id } = req.params
    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: {
        ...sessionIncludeSummary,
      },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })

    const [countedLines, sumSnap] = await Promise.all([
      prisma.inventoryCountLine.count({
        where: {
          session_id: id,
          qty_counted: { not: null },
          ...(scopeDoubleCount(session.scope_json) ? { qty_counted_secondary: { not: null } } : {}),
        },
      }),
      prisma.inventoryCountLine.aggregate({
        where: { session_id: id },
        _sum: { stock_snapshot: true },
      }),
    ])

    const linesWithDiff = await prisma.inventoryCountLine.findMany({
      where: {
        session_id: id,
        qty_counted: { not: null },
        ...(scopeDoubleCount(session.scope_json) ? { qty_counted_secondary: { not: null } } : {}),
      },
      select: { stock_snapshot: true, qty_counted: true, product: { select: { cost: true } } },
    })
    let valueDelta = 0
    for (const L of linesWithDiff) {
      const d = L.qty_counted - L.stock_snapshot
      valueDelta += d * Number(L.product.cost)
    }

    res.json({
      ...session,
      progress: {
        totalLines: session._count.lines,
        countedLines: countedLines,
        pct: session._count.lines ? Math.round((100 * countedLines) / session._count.lines) : 0,
      },
      totals: {
        sumStockSnapshot: sumSnap._sum.stock_snapshot ?? 0,
        valueDeltaApprox: valueDelta,
      },
    })
  } catch (e) {
    next(e)
  }
}

/**
 * GET /inventory-counts/:id/lines
 */
exports.listLines = async (req, res, next) => {
  try {
    const { id } = req.params
    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      select: { id: true, branch_id: true, scope_json: true },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })

    const dc = scopeDoubleCount(session.scope_json)

    const take = Math.min(Number(req.query.limit) || 40, 200)
    const skip = Number(req.query.offset) || 0
    const q = (req.query.q && String(req.query.q).trim()) || ''
    const pendingOnly = ['1', 'true', 'yes'].includes(String(req.query.pending || '').toLowerCase())

    const where = { session_id: id }
    const andFilters = []
    if (q) {
      andFilters.push({
        OR: [
          { product: { name: { contains: q, mode: 'insensitive' } } },
          { product: { barcode: { contains: q, mode: 'insensitive' } } },
        ],
      })
    }
    if (pendingOnly) {
      if (dc) {
        andFilters.push({
          OR: [{ qty_counted: null }, { qty_counted_secondary: null }],
        })
      } else {
        andFilters.push({ qty_counted: null })
      }
    }
    // Se cuenta parado frente a un anaquel: filtrar por ubicación es lo normal.
    if (req.query.location_id) where.location_id = String(req.query.location_id)
    if (andFilters.length) where.AND = andFilters

    const [lines, total] = await Promise.all([
      prisma.inventoryCountLine.findMany({
        where,
        orderBy: [{ location: { code: 'asc' } }, { product: { name: 'asc' } }],
        take,
        skip,
        include: LINE_INCLUDE,
      }),
      prisma.inventoryCountLine.count({ where }),
    ])

    const data = lines.map((L) => ({
      ...L,
      difference:
        L.qty_counted != null ? L.qty_counted - L.stock_snapshot : null,
      valueDifference:
        L.qty_counted != null
          ? (L.qty_counted - L.stock_snapshot) * Number(L.product.cost)
          : null,
      countMismatch:
        dc &&
        L.qty_counted != null &&
        L.qty_counted_secondary != null &&
        L.qty_counted !== L.qty_counted_secondary,
    }))

    res.json({ data, total, take, skip })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /inventory-counts
 * body: { name?, scope?: { categoryIds?, supplierIds?, abcClasses?, samplePercent?, doubleCount? }, notes?, dual_approval? }
 */
exports.create = async (req, res, next) => {
  try {
    const uid = userId(req)
    if (!uid) return res.status(401).json({ message: 'Usuario no identificado' })

    const { name, scope, notes, dual_approval } = req.body || {}
    if (scope && typeof scope === 'object' && Array.isArray(scope.abcClasses) && scope.abcClasses.length) {
      const allowed = new Set(['A', 'B', 'C'])
      const ok = scope.abcClasses.some((x) => allowed.has(String(x).toUpperCase()))
      if (!ok) {
        return res.status(400).json({ message: 'Clases ABC inválidas. Use A, B y/o C.' })
      }
    }
    const scopeClean = sanitizeScope(scope)
    if (
      scope &&
      typeof scope === 'object' &&
      Array.isArray(scope.abcClasses) &&
      scope.abcClasses.length > 0 &&
      !scopeClean.abcClasses
    ) {
      return res.status(400).json({ message: 'Clases ABC inválidas. Use A, B y/o C.' })
    }
    const { requireBranch } = require('../../middlewares/tenant')
    const branchId = requireBranch(req)
    // Acotar a un almacén es opcional; si viene, tiene que ser de esta sucursal.
    const warehouseId = req.body?.warehouse_id ? String(req.body.warehouse_id) : null
    if (warehouseId) {
      const own = await prisma.warehouse.findFirst({
        where: { id: warehouseId, branch_id: branchId },
        select: { id: true },
      })
      if (!own) return res.status(404).json({ message: 'Almacén no encontrado en esta sucursal' })
    }
    const session = await prisma.inventoryCountSession.create({
      data: {
        branch_id: branchId,
        warehouse_id: warehouseId,
        name: name ? String(name).slice(0, 200) : null,
        scope_json: scopeClean,
        notes: notes ? String(notes).slice(0, 2000) : null,
        created_by_id: uid,
        dual_approval: Boolean(dual_approval),
      },
      include: sessionIncludeSummary,
    })
    res.status(201).json(session)
  } catch (e) {
    next(e)
  }
}

/**
 * POST /inventory-counts/:id/start
 */
exports.start = async (req, res, next) => {
  try {
    const { id } = req.params
    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: { _count: { select: { lines: true } } },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })
    if (session.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Solo se puede iniciar una sesión en borrador' })
    }
    if (session._count.lines > 0) {
      return res.status(400).json({ message: 'La sesión ya tiene líneas generadas' })
    }

    await assertNoBlockingSession(id, session.branch_id)

    const products = await resolveProductsForCountStart(session, req.companyId)
    if (!products.length) {
      return res.status(400).json({
        message:
          'No hay productos que coincidan con el alcance del inventariado (revisar categorías, proveedores, ABC o muestreo).',
      })
    }

    // Una línea por (producto, ubicación con existencias). El producto que no
    // está en ninguna cae en la ubicación por defecto: encontrar de más también
    // es un hallazgo del conteo.
    const locations = await countScopeLocations(session)
    const fallback = (locations.find((l) => l.is_default && l.warehouse.is_default) || locations[0]).id
    const stocks = await prisma.productStockLocation.findMany({
      where: {
        product_id: { in: products.map((p) => p.id) },
        location_id: { in: locations.map((l) => l.id) },
        stock: { not: 0 },
      },
      select: { product_id: true, location_id: true, stock: true },
    })
    const byProduct = new Map()
    for (const s of stocks) {
      if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, [])
      byProduct.get(s.product_id).push(s)
    }
    const lineData = products.flatMap((p) => {
      const rows = byProduct.get(p.id) || []
      if (!rows.length) return [{ session_id: id, product_id: p.id, location_id: fallback, stock_snapshot: 0 }]
      return rows.map((r) => ({
        session_id: id,
        product_id: p.id,
        location_id: r.location_id,
        stock_snapshot: Number(r.stock),
      }))
    })

    await prisma.$transaction([
      prisma.inventoryCountLine.createMany({ data: lineData }),
      prisma.inventoryCountSession.update({
        where: { id },
        data: { status: 'IN_PROGRESS', started_at: new Date() },
      }),
    ])

    const updated = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: sessionIncludeSummary,
    })
    res.json(updated)
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ message: e.message })
    next(e)
  }
}

/**
 * PATCH /inventory-counts/:id/lines/:lineId
 * body: { qty_counted?: number, qty_counted_secondary?: number, note? } — al menos un conteo numérico
 */
exports.updateLine = async (req, res, next) => {
  try {
    const { id, lineId } = req.params
    const uid = userId(req)
    if (!uid) return res.status(401).json({ message: 'Usuario no identificado' })

    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      select: { status: true, branch_id: true, scope_json: true },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })
    if (session.status !== 'IN_PROGRESS') {
      return res.status(400).json({ message: 'Solo se puede contar mientras la sesión está en progreso' })
    }

    const qtyRaw = req.body?.qty_counted
    const qty2Raw = req.body?.qty_counted_secondary
    const hasPrimary = qtyRaw !== undefined && qtyRaw !== null && !Number.isNaN(Number(qtyRaw))
    const hasSecondary = qty2Raw !== undefined && qty2Raw !== null && !Number.isNaN(Number(qty2Raw))
    const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : undefined
    const doubleCount = scopeDoubleCount(session.scope_json)

    if (!hasPrimary && !hasSecondary) {
      if (req.body?.note !== undefined) {
        const lineOnly = await prisma.inventoryCountLine.findFirst({
          where: { id: lineId, session_id: id },
          include: LINE_INCLUDE,
        })
        if (!lineOnly) return res.status(404).json({ message: 'Línea no encontrada' })
        const updatedNote = await prisma.inventoryCountLine.update({
          where: { id: lineId },
          data: { note: note || null },
          include: LINE_INCLUDE,
        })
        const mismatch =
          doubleCount &&
          updatedNote.qty_counted != null &&
          updatedNote.qty_counted_secondary != null &&
          updatedNote.qty_counted !== updatedNote.qty_counted_secondary
        return res.json({
          ...updatedNote,
          difference:
            updatedNote.qty_counted != null
              ? updatedNote.qty_counted - updatedNote.stock_snapshot
              : null,
          valueDifference:
            updatedNote.qty_counted != null
              ? (updatedNote.qty_counted - updatedNote.stock_snapshot) * Number(updatedNote.product.cost)
              : null,
          countMismatch: mismatch,
        })
      }
      return res.status(400).json({ message: 'Indique qty_counted y/o qty_counted_secondary' })
    }

    if (hasSecondary && !doubleCount) {
      return res.status(400).json({ message: 'Esta sesión no tiene doble conteo activado' })
    }

    const qtyInt = hasPrimary ? Math.max(0, Math.floor(Number(qtyRaw))) : undefined
    const qty2Int = hasSecondary ? Math.max(0, Math.floor(Number(qty2Raw))) : undefined

    const line = await prisma.inventoryCountLine.findFirst({
      where: { id: lineId, session_id: id },
      include: LINE_INCLUDE,
    })
    if (!line) return res.status(404).json({ message: 'Línea no encontrada' })

    const data = {}
    if (qtyInt !== undefined) {
      data.qty_counted = qtyInt
      data.counted_at = new Date()
      data.counted_by_id = uid
    }
    if (qty2Int !== undefined) {
      data.qty_counted_secondary = qty2Int
      data.counted_secondary_at = new Date()
      data.counted_secondary_by_id = uid
    }
    if (note !== undefined) data.note = note || null

    const updated = await prisma.inventoryCountLine.update({
      where: { id: lineId },
      data,
      include: LINE_INCLUDE,
    })

    const mismatch =
      doubleCount &&
      updated.qty_counted != null &&
      updated.qty_counted_secondary != null &&
      updated.qty_counted !== updated.qty_counted_secondary

    res.json({
      ...updated,
      difference:
        updated.qty_counted != null ? updated.qty_counted - updated.stock_snapshot : null,
      valueDifference:
        updated.qty_counted != null
          ? (updated.qty_counted - updated.stock_snapshot) * Number(updated.product.cost)
          : null,
      countMismatch: mismatch,
    })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /inventory-counts/:id/submit
 * body: { reason: string } obligatorio
 */
exports.submit = async (req, res, next) => {
  try {
    const { id } = req.params
    const reason = req.body?.reason
    if (!reason || String(reason).trim().length < MIN_REASON_LEN) {
      return res.status(400).json({
        message: `Motivo obligatorio al enviar a revisión (mín. ${MIN_REASON_LEN} caracteres)`,
      })
    }
    const reasonStr = String(reason).trim().slice(0, 2000)

    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: { _count: { select: { lines: true } } },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })
    if (session.status !== 'IN_PROGRESS') {
      return res.status(400).json({ message: 'Solo se puede enviar una sesión en progreso' })
    }

    const dc = scopeDoubleCount(session.scope_json)
    const countedWhere = {
      session_id: id,
      qty_counted: { not: null },
      ...(dc ? { qty_counted_secondary: { not: null } } : {}),
    }
    const counted = await prisma.inventoryCountLine.count({ where: countedWhere })
    if (counted < session._count.lines) {
      return res.status(400).json({
        message: `Faltan líneas sin contar (${counted} de ${session._count.lines}). Complete el conteo antes de enviar a revisión.`,
      })
    }

    if (dc) {
      const both = await prisma.inventoryCountLine.findMany({
        where: { session_id: id, qty_counted: { not: null }, qty_counted_secondary: { not: null } },
        select: {
          id: true,
          qty_counted: true,
          qty_counted_secondary: true,
          product: { select: { name: true } },
        },
      })
      const bad = both.filter((L) => L.qty_counted !== L.qty_counted_secondary)
      if (bad.length) {
        const names = bad
          .slice(0, 5)
          .map((L) => L.product?.name || L.id)
          .join(', ')
        return res.status(400).json({
          message: `Doble conteo: ${bad.length} línea(s) con 1.ª y 2.ª lectura distintas. Ej.: ${names}`,
        })
      }
    }

    const updated = await prisma.inventoryCountSession.update({
      where: { id },
      data: {
        status: 'IN_REVIEW',
        submitted_at: new Date(),
        submit_reason: reasonStr,
      },
      include: sessionIncludeSummary,
    })
    res.json(updated)
  } catch (e) {
    next(e)
  }
}

/**
 * POST /inventory-counts/:id/approve
 * body: { reason: string } obligatorio. Con dual_approval: 1.ª pasada → PENDING_SECOND_APPROVAL; 2.ª aplica stock.
 */
exports.approve = async (req, res, next) => {
  try {
    const { id } = req.params
    const uid = userId(req)
    if (!uid) return res.status(401).json({ message: 'Usuario no identificado' })

    const reason = req.body?.reason
    if (!reason || String(reason).trim().length < MIN_REASON_LEN) {
      return res.status(400).json({
        message: `Motivo de aprobación obligatorio (mín. ${MIN_REASON_LEN} caracteres)`,
      })
    }
    const reasonStr = String(reason).trim().slice(0, 2000)

    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      select: {
        status: true,
        branch_id: true,
        dual_approval: true,
        first_approved_by_id: true,
        scope_json: true,
      },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })

    if (!['IN_REVIEW', 'PENDING_SECOND_APPROVAL'].includes(session.status)) {
      return res.status(400).json({ message: 'Estado no válido para aprobar' })
    }

    const dc = scopeDoubleCount(session.scope_json)
    const countedWhere = {
      session_id: id,
      qty_counted: { not: null },
      ...(dc ? { qty_counted_secondary: { not: null } } : {}),
    }
    const countedLines = await prisma.inventoryCountLine.count({ where: countedWhere })
    if (!countedLines) {
      return res.status(400).json({ message: 'No hay líneas contadas para aplicar' })
    }

    /** @type {string[]} */
    let affectedProductIds = []

    if (session.status === 'IN_REVIEW') {
      if (session.dual_approval) {
        await prisma.inventoryCountSession.update({
          where: { id },
          data: {
            status: 'PENDING_SECOND_APPROVAL',
            first_approved_at: new Date(),
            first_approved_by_id: uid,
            first_approval_reason: reasonStr,
          },
        })
      } else {
        await prismaTransaction.$transaction(
          async (tx) => {
            affectedProductIds = await applyStockTransaction(tx, id, session.branch_id)
            await tx.inventoryCountSession.update({
              where: { id },
              data: {
                status: 'APPROVED',
                approved_at: new Date(),
                approved_by_id: uid,
                final_approval_reason: reasonStr,
              },
            })
          },
          INVENTORY_APPROVE_TX_OPTIONS
        )
      }
    } else if (session.status === 'PENDING_SECOND_APPROVAL') {
      if (session.first_approved_by_id === uid) {
        return res.status(400).json({
          message: 'La segunda aprobación debe ser realizada por un usuario distinto al de la primera',
        })
      }
      await prismaTransaction.$transaction(
        async (tx) => {
          affectedProductIds = await applyStockTransaction(tx, id, session.branch_id)
          await tx.inventoryCountSession.update({
            where: { id },
            data: {
              status: 'APPROVED',
              approved_at: new Date(),
              approved_by_id: uid,
              final_approval_reason: reasonStr,
            },
          })
        },
        INVENTORY_APPROVE_TX_OPTIONS
      )
    }

    if (affectedProductIds.length) {
      try {
        // Alertas con el stock/min de la sucursal de la sesión
        const branchRows = await prisma.productStock.findMany({
          where: { branch_id: session.branch_id, product_id: { in: affectedProductIds } },
          select: { product_id: true, stock: true, min_stock: true },
        })
        const refreshed = branchRows.map((r) => ({ id: r.product_id, stock: r.stock, min_stock: r.min_stock }))
        await ensureStockAlertsBatch(prisma, refreshed, session.branch_id)
      } catch (alertErr) {
        console.error('[inventoryCounts.approve] alertas stock:', alertErr.message)
      }
    }

    const updated = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      include: sessionIncludeSummary,
    })
    res.json(updated)
  } catch (e) {
    next(e)
  }
}

/**
 * POST /inventory-counts/:id/cancel
 * body: { reason: string }
 */
exports.cancel = async (req, res, next) => {
  try {
    const { id } = req.params
    const reason = req.body?.reason
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: 'Indique el motivo de cancelación' })
    }

    const session = await prisma.inventoryCountSession.findFirst({
      where: { id, branch: { company_id: req.companyId } },
      select: { status: true },
    })
    if (!session) return res.status(404).json({ message: 'Sesión no encontrada' })
    if (!['DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'PENDING_SECOND_APPROVAL'].includes(session.status)) {
      return res.status(400).json({ message: 'No se puede cancelar esta sesión' })
    }

    const updated = await prisma.inventoryCountSession.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelled_at: new Date(),
        cancel_reason: String(reason).slice(0, 2000),
      },
      include: sessionIncludeSummary,
    })
    res.json(updated)
  } catch (e) {
    next(e)
  }
}
