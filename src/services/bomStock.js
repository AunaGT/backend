/**
 * Kits/combos (BOM): explosión de líneas para stock y disponibilidad.
 */

const { Prisma } = require('@prisma/client')
const { parseQuantity } = require('./units/quantity')
const { Decimal, decimal, physicalQuantity, storageQuantity, lockPhysicalProducts } = require('./units/physical')
const { prisma } = require('../models/prisma')
const { parseCatalogKind, commercialQuantity, assertPhysicalItem, assertServicesEnabled } = require('./catalogItemRules')

function dbClient(tx) {
  return tx || prisma
}

const BOM_INCLUDE = {
  kit_components: {
    orderBy: { sort_order: 'asc' },
    include: {
      component_product: {
        select: { id: true, name: true, kind: true, quantity_decimals:true, deleted: true, available_for_sale: true },
      },
    },
  },
}

function parseKind(raw) {
  return parseCatalogKind(raw)
}

function normalizeBomInput(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row, idx) => ({
      component_product_id: String(row.component_product_id || row.product_id || '').trim(),
      qty_per_unit: storageQuantity(parseQuantity(row.qty_per_unit ?? row.qty ?? 1)),
      sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : idx,
    }))
    .filter((row) => row.component_product_id)
}

async function loadProductsWithBom(tx, productIds, { companyId,allowArchivedServices=false } = {}) {
  const client = dbClient(tx)
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  if (ids.length === 0) return new Map()
  const cached=require('./checkoutContext').checkoutProducts(client,ids,{companyId})
  const rows = cached?[...cached.values()].filter(p=>!p.deleted||allowArchivedServices&&p.kind==='SERVICE'):await client.product.findMany({
    where: { id: { in: ids }, ...(allowArchivedServices ? {OR:[{deleted:false},{kind:'SERVICE'}]} : {deleted:false}), ...(companyId ? {company_id:companyId} : {}) },
    select: {
      id: true,
      name: true,
      kind: true,
      company_id: true,
      service_unit_label: true,
      quantity_decimals: true,
      available_for_sale: true,
      stock: true,
      stock_assembled: true,
      kit_components: {
        orderBy: { sort_order: 'asc' },
        select: {
          component_product_id: true,
          qty_per_unit: true,
          component_product: { select: { id: true, name: true, kind: true, quantity_decimals:true, deleted: true } },
        },
      },
    },
  })
  if (!companyId && rows.some(p=>p.kind==='SERVICE')) throw Object.assign(new Error('Empresa requerida para servicios'),{status:403})
  const result = new Map(rows.map((p) => [String(p.id), p]))
  for (const id of ids) if (!result.has(id)) throw Object.assign(new Error(`Producto no encontrado: ${id}`),{status:400})
  return result
}

/**
 * Disponibilidad de kits = mínimo floor(componente.disponible / qty_por_unidad).
 */
function computeKitAvailableFromBom(bomLines, availabilityMap) {
  if (!bomLines?.length) return 0
  let min = Infinity
  for (const line of bomLines) {
    const compId = String(line.component_product_id)
    const need = parseQuantity(line.qty_per_unit ?? 1)
    const available = decimal(availabilityMap[compId]?.available)
    min = Math.min(min, available.div(need).floor().toNumber())
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0
}

async function getAvailabilityBatchWithKits(productIds, tx, branchId, { locationId = null, companyId } = {}) {
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  if (ids.length === 0) return {}

  const prodMap = await loadProductsWithBom(tx, ids, {companyId})
  if ([...prodMap.values()].some(p=>p.kind==='SERVICE')) await assertServicesEnabled(dbClient(tx),companyId)
  const componentIds = new Set()
  for (const p of prodMap.values()) {
    if (p.kind === 'KIT') {
      for (const line of p.kit_components) {
        assertPhysicalItem(line.component_product)
        componentIds.add(String(line.component_product_id))
      }
    }
  }

  const allIds = [...new Set([...ids.filter(id=>prodMap.get(id).kind!=='SERVICE'), ...componentIds])]
  const { getAvailabilityBatch } = require('./stockAvailability')
  const base = allIds.length ? await getAvailabilityBatch(allIds, tx, { branchId, locationId }) : {}
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
    if (p.kind === 'SERVICE') {
      out[id] = {tracks_stock:false,available_for_sale:p.available_for_sale,unit_label:p.service_unit_label,quantity_decimals:p.quantity_decimals}
      continue
    }
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
async function expandLinesToStockMap(tx, lines, { companyId,allowArchivedServices=false } = {}) {
  const productIds = lines.map((l) => String(l.product_id))
  const prodMap = await loadProductsWithBom(tx, productIds, {companyId,allowArchivedServices})
  const out = new Map()

  for (const line of lines) {
    const pid = String(line.product_id)
    const product = prodMap.get(pid)
    if (!product) {
      const err = new Error(`Producto no encontrado: ${pid}`)
      err.status = 400
      throw err
    }
    if (product.kind === 'SERVICE') {
      commercialQuantity(line.qty, line.item_kind === 'SERVICE' ? line : product)
      continue
    }
    const qty = physicalQuantity(line.base_qty ?? line.qty, product)

    if (product.kind === 'KIT' && !product.stock_assembled) {
      if (!product.kit_components.length) {
        const err = new Error(`El kit "${product.name}" no tiene componentes configurados`)
        err.status = 400
        throw err
      }
      for (const comp of product.kit_components) {
        assertPhysicalItem(comp.component_product)
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
        const compQty = physicalQuantity(qty.mul(parseQuantity(comp.qty_per_unit ?? 1)),comp.component_product)
        out.set(compId, storageQuantity(parseQuantity(decimal(out.get(compId)).add(compQty))))
      }
    } else {
      out.set(pid, storageQuantity(parseQuantity(decimal(out.get(pid)).add(qty))))
    }
  }
  return out
}

async function stockMapToLines(stockMap) {
  return Array.from(stockMap.entries()).map(([product_id, qty]) => ({ product_id, qty }))
}

async function stockMapFromMovements(tx, {refType,refId,reason,groupId}) {
  const rows = await tx.stockMovement.findMany({where:groupId?{group_id:String(groupId)}:{ref_type:String(refType),ref_id:String(refId),reason},select:{product_id:true,qty:true}})
  const out = new Map()
  for (const row of rows) {
    const qty = decimal(row.qty)
    if (qty.lt(0)) out.set(String(row.product_id),storageQuantity(decimal(out.get(String(row.product_id))).sub(qty)))
  }
  return out
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
  const entries = Array.from(stockMap.entries()).map(([id, qty]) => [id, parseQuantity(qty, {allowZero:true})]).filter(([, qty]) => qty.gt(0)).sort(([a],[b]) => String(a).localeCompare(String(b)))
  if (entries.length === 0) return []
  const b = requireBranchId(branchId)
  await ensureBranchStockRows(client, entries.map(([id]) => id), b)
  // El mismo delta, repartido por ubicación (y anotado en el kardex).
  await applyBranchDelta(client, entries, b, sign, ctx)
  return applyStockMirrorDelta(client,entries.map(([id,qty])=>[id,qty.mul(sign)]),b)
}

async function applyStockMirrorDelta(client,entries,b) {
  if(!entries.length)return []
  const values = Prisma.join(
    entries.map(([id, qty]) => Prisma.sql`(${id}::uuid, ${qty.toFixed()}::numeric)`)
  )
  const result=await client.$queryRaw`
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
  require('./checkoutContext').checkoutStockDelta(client,entries,b)
  return result
}

// Count locations are one server-derived operation: only its final net reaches mirrors.
async function applyCountStockDeltas(tx,deltas,branchId,ctx) {
  if(!deltas.length)return []
  const {requireBranchId,ensureBranchStockRows}=require('./stockAvailability')
  const {assertBranchLocations,applyLocationDeltas}=require('./stockLocations')
  const b=requireBranchId(branchId),ids=[...new Set(deltas.map(row=>String(row.product_id)))].sort()
  const products=await lockPhysicalProducts(tx,ids,b)
  const rows=deltas.map(row=>({...row,qty:physicalQuantity(row.qty,products.get(String(row.product_id)),{signed:true,allowZero:true}).toFixed()}))
  const net=new Map()
  for(const row of rows)net.set(String(row.product_id),decimal(net.get(String(row.product_id))).add(row.qty))
  await ensureBranchStockRows(tx,ids,b)
  await require('./units/physical').assertStockDeltaBounds(tx,products,b,[...net],1)
  await assertBranchLocations(tx,b,rows.map(row=>row.location_id))
  await applyLocationDeltas(tx,rows,{...ctx,branchId:b})
  return applyStockMirrorDelta(tx,[...net].filter(([,qty])=>!qty.isZero()),b)
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
  const kits = parseQuantity(qty, { decimals: 0 })
  const map = new Map()
  for (const line of bomLines) {
    const compId = String(line.component_product_id)
    const need = parseQuantity(parseQuantity(line.qty_per_unit ?? 1).mul(kits))
    map.set(compId, storageQuantity(parseQuantity(decimal(map.get(compId)).add(need))))
  }
  return map
}

/**
 * Arma unidades de un kit ahora mismo EN UNA SUCURSAL: descuenta los
 * componentes de esa sucursal y le da al kit stock propio real ahí
 * (stock_assembled = true). Si se pasa `requestedQty` se arma esa cantidad
 * (limitada al máximo disponible); si no, el máximo.
 */
async function assembleKit(tx, kitProductId, requestedQty, branchId, { actorId = null } = {}) {
  const desiredQty=requestedQty===undefined?undefined:parseQuantity(requestedQty,{decimals:0}).toNumber()
  const client = dbClient(tx)
  const { requireBranchId } = require('./stockAvailability')
  const b = requireBranchId(branchId)
  let kit = await client.product.findFirst({
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
  const lockedProducts=await lockPhysicalProducts(client, [String(kitProductId),...componentIds], b)
  kit=await client.product.findFirst({where:{id:kitProductId,deleted:false},select:{id:true,name:true,kind:true,kit_components:{select:{component_product_id:true,qty_per_unit:true}}}})
  if(!kit||kit.kind!=='KIT'||!kit.kit_components.length||kit.kit_components.some(c=>!componentIds.includes(String(c.component_product_id))))throw Object.assign(new Error('La configuración del kit cambió. Recarga el producto.'),{status:409})
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
    qty = desiredQty
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

  const deductionMap = buildComponentDeductionMap(kit.kit_components, qty)
  const assemblyValuation=new Map()
  let value=decimal(0)
  for(const [id,quantity] of deductionMap){
    const component=lockedProducts.get(id)
    const unitCost=parseQuantity(component.cost??0,{decimals:12,allowZero:true,max:'999999999999.999999999999'}).toFixed(12)
    value=value.add(decimal(quantity).mul(unitCost))
    assemblyValuation.set(id,{role:'COMPONENT',qty:String(quantity),unitCost,tracksExpiry:!!component.tracks_expiry})
  }
  const kitProduct=lockedProducts.get(String(kitProductId))
  const batchCost=parseQuantity(value.div(qty).toDecimalPlaces(12),{decimals:12,allowZero:true,max:'999999999999.999999999999'}).toFixed(12)
  const kitCost=require('./kitAssemblies').creditedCost(kitProduct,qty,value)
  assemblyValuation.set(String(kitProductId),{role:'KIT',qty:String(qty),unitCost:batchCost,value:value.toFixed(),tracksExpiry:!!kitProduct.tracks_expiry})
  const kitCtx = { reason: 'KIT_ASSEMBLE', refType: 'product', refId: String(kitProductId),groupId:require('crypto').randomUUID(),consumeLots:true,assemblyValuation,userId:actorId }
  await deductStockMap(tx, deductionMap, b, kitCtx)

  // Stock propio del kit en esta sucursal (+ espejo global en products.stock)
  const locationId=await require('./stockLocations').defaultLocationId(client,b,{receiving:true})
  const assemblyLots=new Map()
  if(kitProduct.tracks_expiry){
    const lot={lot_code:require('./lots').generateLotCode(),expiry_date:null,unit_cost:batchCost,supplier_id:null,location_id:locationId,qty:String(qty)}
    await client.productLot.create({data:{product_id:String(kitProductId),branch_id:b,location_id:locationId,lot_code:lot.lot_code,qty_received:qty,qty_remaining:qty,unit_cost:batchCost}})
    assemblyLots.set(String(kitProductId),[lot])
  }
  const [kitRow] = await restoreStockMap(tx, new Map([[String(kitProductId), qty]]), b, {...kitCtx,locationId,assemblyLots})
  const product = await client.product.update({
    where: { id: kitProductId },
    data: { stock_assembled: true,cost:kitCost },
    select: { id: true, name: true, stock: true, min_stock: true, stock_assembled: true,cost:true },
  })

  return {
    qty,
    assembly_group_id:kitCtx.groupId,
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
    select: { company_id: true, kind:true },
  })
  if (!kit) {
    const err = new Error('Producto no encontrado')
    err.status = 404
    throw err
  }
  assertPhysicalItem(kit)
  const componentIds = rows.map((r) => r.component_product_id)
  const products = await dbClient(tx).product.findMany({
    where: { id: { in: componentIds }, deleted: false, company_id: kit.company_id },
    select: { id: true, name: true, kind: true, quantity_decimals:true },
  })
  const prodMap = new Map(products.map((p) => [String(p.id), p]))

  for (const row of rows) {
    const p = prodMap.get(row.component_product_id)
    assertPhysicalItem(p)
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
    physicalQuantity(row.qty_per_unit,p)
  }
  return rows
}

async function replaceProductBom(tx, kitProductId, components) {
  const client = dbClient(tx)
  await client.$executeRaw`SELECT id FROM products WHERE id=${String(kitProductId)}::uuid FOR UPDATE`
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
  stockMapFromMovements,
  deductStockMap,
  restoreStockMap,
  applyCountStockDeltas,
  buildComponentDeductionMap,
  assembleKit,
  validateBomComponents,
  replaceProductBom,
}
