const { randomUUID } = require('crypto')
const { decimal, lockPhysicalProducts } = require('./units/physical')
const { parseQuantity } = require('./units/quantity')
const COST_MAX = '999999999999.999999999999'
const fail = (message, status = 409, code = 'KIT_ASSEMBLY_SNAPSHOT_REQUIRED') => { throw Object.assign(new Error(message), { status, code }) }
const costText = value => parseQuantity(decimal(value).toDecimalPlaces(12), { decimals: 12, allowZero: true, max: COST_MAX }).toFixed(12)

async function kitInScope(db, productId, branchId, companyId) {
  if(!companyId||!branchId)fail('Selecciona una empresa y sucursal activa',404,'KIT_NOT_FOUND')
  const branch = await db.branch.findFirst({ where: { id: branchId, company_id: companyId, active: true }, select: { id: true } })
  const product = branch && await db.product.findFirst({ where: { id: productId, company_id: companyId, deleted: false, kind: 'KIT' } })
  if (!product) fail('Kit no encontrado en la empresa y sucursal activa', 404, 'KIT_NOT_FOUND')
  return product
}

// Same company-average receipt policy as purchases: nonpositive opening stock uses the incoming cost.
function creditedCost(product, qty, value) {
  const stock = decimal(product.stock)
  return costText(stock.gt(0) ? stock.mul(decimal(product.cost)).add(value).div(stock.add(qty)) : decimal(value).div(qty))
}

function debitedCost(product, qty, value) {
  const stock = decimal(product.stock), remaining = stock.sub(qty)
  const restValue = stock.mul(decimal(product.cost)).sub(value)
  // A stored 12-place average can differ from its original exact batch value by half a quantum per unit.
  const tolerance = stock.abs().mul('0.0000000000005')
  if (remaining.lt(0) || restValue.lt(tolerance.neg()) || (remaining.isZero() && restValue.abs().gt(tolerance))) {
    fail('La valoración actual del kit no permite revertir este armado completo', 409, 'KIT_ASSEMBLY_VALUATION_CONFLICT')
  }
  if (remaining.isZero()) return costText(product.cost)
  if(restValue.div(remaining).gt(COST_MAX))fail('La valoración restante del kit excede el rango permitido',409,'KIT_ASSEMBLY_VALUATION_CONFLICT')
  return costText(decimal(restValue).lt(0) ? '0' : restValue.div(remaining))
}

function valueText(raw) {
  if (typeof raw !== 'string' || raw.length > 128 || !/^\d+(?:\.\d{1,18})?$/.test(raw)) fail('El armado no conserva una valoración completa')
  const value = decimal(raw)
  if (!value.isFinite() || value.lt(0) || value.gt('99999999999999999999.999999999999999999')) fail('Valor de armado fuera de rango')
  return value
}

function frozenAssembly(rows, productId) {
  try {
  if (rows.length < 2) fail('Este armado no conserva los snapshots necesarios para desarmarlo')
  const credits = rows.filter(row => decimal(row.qty).gt(0))
  const components = rows.filter(row => decimal(row.qty).lt(0)).sort((a,b)=>String(a.product_id).localeCompare(String(b.product_id))||String(a.location_id).localeCompare(String(b.location_id)))
  if (credits.length !== 1 || credits[0].product_id !== productId || !components.length || components.some(row => row.product_id === productId)) fail('El evento no es un armado completo válido')
  for (const row of rows) {
    const snapshot = row.unit_snapshot, info = snapshot?.assembly
    const qty = decimal(row.qty).abs()
    if (!snapshot || ![1, 2].includes(snapshot.version) || !Array.isArray(snapshot.lots) || info?.version !== 1 || typeof info.tracks_expiry !== 'boolean' || info.role !== (row === credits[0] ? 'KIT' : 'COMPONENT')) fail('Este armado no conserva los snapshots necesarios para desarmarlo')
    if (!parseQuantity(info.base_qty).eq(qty)) fail('Cantidad congelada de armado inválida')
    if (snapshot.version === 2) {
      if(!snapshot.baseUnit||!Number.isInteger(snapshot.baseUnit.decimals)||snapshot.baseUnit.decimals<0||snapshot.baseUnit.decimals>6||!['id','code','name','label'].every(key=>typeof snapshot.baseUnit[key]==='string'&&snapshot.baseUnit[key]))fail('Unidad congelada de armado incompleta')
      parseQuantity(info.base_qty, { decimals: snapshot.baseUnit.decimals })
    }
    const cost = parseQuantity(info.unit_cost, { decimals: 12, allowZero: true, max: COST_MAX })
    const value = valueText(info.value)
    if (info.role === 'COMPONENT' && !qty.mul(cost).eq(value)) fail('Valor congelado del componente inválido')
    if (info.role === 'KIT' && (!qty.isInteger() || !value.div(qty).toDecimalPlaces(12).eq(cost))) fail('Valor congelado del kit inválido')
    let lotted = decimal(0)
    for (const lot of snapshot.lots) {
      const lotQty = parseQuantity(lot.qty)
      if (lot.location_id !== row.location_id || (lot.expiry_date != null && (typeof lot.expiry_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lot.expiry_date) || Number.isNaN(new Date(lot.expiry_date).getTime())))) fail('Lotes congelados del armado inválidos')
      if (lot.unit_cost != null) parseQuantity(lot.unit_cost, { decimals: 12, allowZero: true, max: COST_MAX })
      lotted = lotted.add(lotQty)
    }
    if (lotted.gt(qty) || (info.tracks_expiry && !lotted.eq(qty))) fail('Los lotes congelados no cubren el armado')
  }
  const total = components.reduce((sum, row) => sum.add(row.unit_snapshot.assembly.value), decimal(0))
  if (!total.eq(credits[0].unit_snapshot.assembly.value)) fail('El valor del armado no coincide con sus componentes')
  return { kit: credits[0], components, qty: decimal(credits[0].qty).toFixed(), value: total.toFixed() }
  } catch(error) {
    if(error.status===400)fail('Este armado no conserva los snapshots completos necesarios para desarmarlo')
    throw error
  }
}

const scopeWhere = (companyId, branchId) => ({ branch_id: branchId, branch: { company_id: companyId } })
function reversalResult(assemblyId, reversalId, event) {
  return { assembly_group_id: assemblyId, reversal_group_id: reversalId, qty: event.qty, value: event.value }
}

async function disassembleKit(tx, { productId, branchId, companyId, actorId, input }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'assembly_group_id') || typeof input.assembly_group_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.assembly_group_id)) fail('Selecciona un evento completo de armado válido', 400, 'INVALID_KIT_ASSEMBLY')
  await kitInScope(tx, productId, branchId, companyId)
  const assemblyId = input.assembly_group_id.toLowerCase()
  // All writers of a KIT_DISASSEMBLE claim use this transaction lock and append the claim with its stock rows.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kit-assembly-reverse:${companyId}:${branchId}:${assemblyId}`},0))`
  const scope = scopeWhere(companyId, branchId)
  const rows = await tx.stockMovement.findMany({ where: { ...scope, group_id: assemblyId, reason: 'KIT_ASSEMBLE', ref_type: 'product', ref_id: productId }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] })
  if (!rows.length) fail('Armado no encontrado en este kit y sucursal', 404, 'KIT_ASSEMBLY_NOT_FOUND')
  const event = frozenAssembly(rows, productId)
  const previous = await tx.stockMovement.findMany({ where: { ...scope, reason: 'KIT_DISASSEMBLE', ref_type: 'kit_assembly', ref_id: assemblyId }, take: 1 })
  if (previous.length) return reversalResult(assemblyId, previous[0].group_id, event)

  const products = await lockPhysicalProducts(tx, rows.map(row => row.product_id), branchId)
  if(products.get(productId)?.kind!=='KIT')fail('El tipo del kit cambió. Recarga el producto antes de revertir el armado',409,'KIT_ASSEMBLY_TYPE_CONFLICT')
  const { assertBranchLocations } = require('./stockLocations')
  try { await assertBranchLocations(tx, branchId, rows.map(row => row.location_id)) } catch (error) {
    if (error.status !== 403) throw error
    fail('Una ubicación original del armado ya no está activa en esta sucursal', 409, 'KIT_ASSEMBLY_LOCATION_UNAVAILABLE')
  }
  const { getAvailabilityBatch } = require('./stockAvailability')
  const available = await getAvailabilityBatch([productId], tx, { branchId, locationId: event.kit.location_id })
  if (decimal(available[productId]?.available).lt(event.qty) || decimal(available[productId]?.location_stock).lt(event.qty)) fail('No hay suficientes kits libres en la ubicación original para desarmar este evento completo', 409, 'KIT_ASSEMBLY_STOCK_REQUIRED')

  const kitCost = debitedCost(products.get(productId), event.qty, event.value)
  const componentTotals = new Map()
  for (const row of event.components) {
    const total = componentTotals.get(row.product_id) || { qty: decimal(0), value: decimal(0) }
    total.qty = total.qty.sub(row.qty); total.value = total.value.add(row.unit_snapshot.assembly.value)
    componentTotals.set(row.product_id, total)
  }
  const costs = new Map([...componentTotals].map(([id, total]) => [id, creditedCost(products.get(id), total.qty, total.value)]))
  const groupId = randomUUID()
  const ctx = { reason: 'KIT_DISASSEMBLE', refType: 'kit_assembly', refId: assemblyId, groupId, userId: actorId }
  const { deductStockMap, restoreStockMap } = require('./bomStock')
  await deductStockMap(tx, new Map([[productId, event.qty]]), branchId, { ...ctx, locationId: event.kit.location_id, unitSnapshots: new Map([[productId, event.kit.unit_snapshot]]) })
  await require('./lots').consumeLotsFEFO(tx, new Map([[productId, event.qty]]), branchId, new Map([[productId, [{ location_id: event.kit.location_id, qty: event.qty }]]]))
  for (const row of event.components) {
    const qty = decimal(row.qty).abs().toFixed()
    await restoreStockMap(tx, new Map([[row.product_id, qty]]), branchId, { ...ctx, locationId: row.location_id, unitSnapshots: new Map([[row.product_id, row.unit_snapshot]]) })
    await require('./lots').recreateLotsFromSnapshot(tx, row.product_id, branchId, row.unit_snapshot.lots, qty, row.location_id)
  }
  await tx.product.update({ where: { id: productId }, data: { cost: kitCost } })
  for (const [id, cost] of costs) await tx.product.update({ where: { id }, data: { cost } })
  const changed = await tx.productStock.findMany({ where: { branch_id: branchId, product_id: { in: [...products.keys()] } }, select: { product_id: true, stock: true, min_stock: true } })
  await require('./stockAlerts').ensureStockAlertsBatch(tx, changed.map(row => ({ id: row.product_id, ...row })), branchId)
  return reversalResult(assemblyId, groupId, event)
}

async function listKitAssemblies(db, { productId, branchId, companyId, query = {} }) {
  await kitInScope(db, productId, branchId, companyId)
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(query.pageSize) || 20))), page = Math.max(1, Math.floor(Number(query.page) || 1))
  const scope = scopeWhere(companyId, branchId)
  const where = { ...scope, product_id: productId, reason: 'KIT_ASSEMBLE', ref_type: 'product', ref_id: productId, qty: { gt: 0 } }
  const totalItems = await db.stockMovement.count({ where })
  const credits = await db.stockMovement.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: pageSize, skip: (page - 1) * pageSize })
  const ids = credits.map(row => row.group_id).filter(Boolean)
  const rows = ids.length ? await db.stockMovement.findMany({ where: { ...scope, group_id: { in: ids }, reason: 'KIT_ASSEMBLE', ref_type: 'product', ref_id: productId }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] }) : []
  const reversed = ids.length ? await db.stockMovement.findMany({ where: { ...scope, ref_id: { in: ids }, ref_type: 'kit_assembly', reason: 'KIT_DISASSEMBLE' } }) : []
  const items = credits.map(credit => {
    const reversal = reversed.find(row => row.ref_id === credit.group_id)
    let event
    try { event = frozenAssembly(rows.filter(row => row.group_id === credit.group_id), productId) } catch { event = null }
    return {
      assembly_group_id: credit.group_id || null, created_at: credit.created_at, qty: decimal(credit.qty).toFixed(),
      value: event?.value ?? null, unit_cost: event?.kit.unit_snapshot.assembly.unit_cost ?? null,
      status: reversal ? 'REVERSED' : event ? 'READY' : 'SNAPSHOT_REQUIRED', reversal_group_id: reversal?.group_id ?? null,
      components: event?.components.map(row => ({ product_id: row.product_id, location_id: row.location_id, qty: decimal(row.qty).abs().toFixed(), value: row.unit_snapshot.assembly.value, unit_cost: row.unit_snapshot.assembly.unit_cost, unit_snapshot: row.unit_snapshot })) ?? [],
    }
  })
  return { items, page, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)) }
}

module.exports = { kitInScope, creditedCost, disassembleKit, listKitAssemblies }
