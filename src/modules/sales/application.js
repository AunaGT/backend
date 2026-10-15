const { round2 } = require('../../services/accounting/logic')
const { randomUUID } = require('crypto')
const { getAvailabilityBatchWithKits, expandLinesToStockMap, deductStockMap } = require('../../services/bomStock')
const { resolvePriceTierForContext, resolveUnitPriceFromProduct } = require('../../services/priceResolution')
const { consumeLotsFEFO } = require('../../services/lots')
const { dispatchedByRef } = require('../../services/stockLocations')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const { nextDocumentReference } = require('../../services/referenceGenerator')
const { allocateNetLineTotals } = require('../../services/saleLineTotals')
const { Prisma } = require('@prisma/client')
const { commercialQuantity,lineSnapshot,assertServicesEnabled } = require('../../services/catalogItemRules')
const { validMoney } = require('../../utils/importValidation')

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status })
}

function exchangeDifference(returnedValue, replacementValue) {
  const difference = round2(Number(replacementValue) - Number(returnedValue))
  return {
    amount: Math.abs(difference),
    direction: difference > 0 ? 'COLLECTION' : difference < 0 ? 'REFUND' : 'NONE',
  }
}

function exchangeSettlement({ difference, channel, hasCustomer }) {
  const selected = String(channel || 'ORIGINAL').toUpperCase()
  if (difference.direction === 'REFUND' && selected === 'CUSTOMER_CREDIT') {
    if (!hasCustomer) fail('El saldo a favor requiere un cliente maestro identificado', 409)
    return { kind: 'CUSTOMER_CREDIT', amount: difference.amount, requiresDirectMethod: false }
  }
  return {
    kind: difference.direction === 'REFUND' ? 'REFUND' : 'COLLECTION',
    amount: difference.amount,
    requiresDirectMethod: difference.direction !== 'NONE',
  }
}

async function resolvePricedSaleItems(tx, {
  items,
  branchId,
  companyId,
  customerContactId = null,
  salesChannel = 'POS',
  pricing = 'CURRENT_PRICE',
  originalSaleItems = [],
  approvedSnapshots = [],
  allowPriceOverride = false,
  availability = getAvailabilityBatchWithKits,
}) {
  if (!Array.isArray(items) || items.length === 0) fail('Selecciona al menos un producto de reemplazo')
  const ids = [...new Set(items.map(raw=>String(raw?.product_id || '')))]
  for (const raw of items) {
    const id = String(raw?.product_id || '')
    if (!id) fail('Cada reemplazo requiere un producto')
    if (!allowPriceOverride && (raw.unit_price != null || raw.price != null)) {
      fail('El precio enviado por el navegador no está autorizado')
    }
  }
  const products = await tx.product.findMany({
    where: { id: { in: ids }, company_id: companyId, deleted: false },
    select: {
      id: true, name: true, available_for_sale: true, price: true, price_wholesale: true,
      price_promotion: true, promotion_valid_until: true, cost: true,
      kind:true,service_unit_label:true,quantity_decimals:true,
    },
  })
  const byId = new Map(products.map((product) => [String(product.id), product]))
  // Only the internal completion caller supplies snapshots loaded from the approved return.
  const approved = new Map(approvedSnapshots.map(line=>[String(line.product_id),line]))
  const rulesFor = product => { const snapshot=approved.get(String(product.id)); return snapshot && snapshot.item_kind===product.kind ? snapshot : product }
  const qtyByProduct = new Map()
  const quantities = items.map(raw=>{
    const id = String(raw.product_id)
    const product = byId.get(id)
    if (!product || !product.available_for_sale) fail(`Producto de reemplazo no encontrado o no disponible: ${id}`)
    const qty = commercialQuantity(raw.qty,rulesFor(product))
    const aggregate = (qtyByProduct.get(id) || new Prisma.Decimal(0)).add(qty)
    commercialQuantity(aggregate,rulesFor(product))
    qtyByProduct.set(id,aggregate)
    return qty
  })
  if (products.some(product=>product.kind==='SERVICE')) await assertServicesEnabled(tx,companyId)
  const physicalIds = ids.filter(id=>byId.get(id).kind!=='SERVICE')
  const stock = physicalIds.length ? await availability(physicalIds, tx, branchId, {companyId}) : {}
  const tier = await resolvePriceTierForContext(tx, { customerContactId, salesChannel,companyId })
  const historical = new Map(originalSaleItems.map((line) => [String(line.product_id), line]))
  const now = new Date()

  return items.map((raw,index) => {
    const productId = String(raw.product_id)
    const product = byId.get(productId)
    if (!product || !product.available_for_sale) fail(`Producto de reemplazo no encontrado o no disponible: ${productId}`)
    const qty = quantities[index]
    const available = Number(stock[productId]?.available ?? 0)
    if (product.kind !== 'SERVICE' && qtyByProduct.get(productId).gt(available)) {
      fail(`Stock insuficiente para ${product.name}. Disponible: ${available}`, 409)
    }
    const source = historical.get(productId)
    const historicalPrice = source && Number(source.qty) > 0
      ? Number(source.net_total ?? Number(source.price) * Number(source.qty)) / Number(source.qty)
      : null
    const override = allowPriceOverride ? Number(raw.unit_price ?? raw.price) : null
    if (allowPriceOverride && (raw.unit_price != null || raw.price != null) && !validMoney(override)) {
      fail('El precio autorizado no es válido')
    }
    const unitPrice = round2(Number.isFinite(override)
      ? override
      : pricing === 'ORIGINAL_SALE_PRICE' && Number.isFinite(historicalPrice)
        ? historicalPrice
        : resolveUnitPriceFromProduct(product, tier, now))
    return {
      product_id: productId,
      qty:qty.toString(),
      unit_price: unitPrice,
      line_total: checkedLineTotal(qty,unitPrice),
      unit_cost: product.kind === 'SERVICE' ? 0 : product.cost == null ? null : Number(product.cost),
      ...lineSnapshot(rulesFor(product)),
    }
  })
}

function checkedLineTotal(qty,price) {
  if (!validMoney(price)) fail('Precio fuera de rango')
  const total = qty.mul(String(price)).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP)
  if (total.gte('10000000000')) fail('Importe fuera de rango')
  return total.toNumber()
}

async function moveSaleStock(tx, items, branchId, ctx) {
  const stockMap = await expandLinesToStockMap(tx, items, {companyId:ctx.companyId,allowArchivedServices:ctx.allowArchivedServices===true})
  if (!stockMap.size) return []
  const groupId = randomUUID()
  const products = await deductStockMap(tx, stockMap, branchId, { ...ctx, groupId })
  await consumeLotsFEFO(tx, stockMap, branchId, await dispatchedByRef(tx, { groupId }))
  await ensureStockAlertsBatch(tx, products, branchId)
  return products
}

async function insertSaleRecord(tx, { saleData, items, userId }) {
  for (const field of ['subtotal','discount_total','total']) if (saleData[field]!=null && !validMoney(Number(saleData[field]))) fail('Importe de venta fuera de rango')
  if (!Number.isSafeInteger(saleData.items) || saleData.items<0 || saleData.items>2147483647) fail('Cantidad física total fuera de rango')
  const netTotals = items.every((item) => item.line_total != null)
    ? items.map((item) => Number(item.line_total))
    : allocateNetLineTotals(items.map((item) => ({ price: item.unit_price, qty: item.qty })), saleData.total)
  const sale = await tx.sale.create({ data: { ...saleData, created_by: userId } })
  await tx.saleItem.createMany({
    data: items.map((item, index) => ({
      sale_id: sale.id,
      product_id: item.product_id,
      qty: item.qty,
      price: item.unit_price,
      unit_cost: item.unit_cost ?? null,
      net_total: netTotals[index],
      ...(item.item_kind ? {item_name:item.item_name,item_kind:item.item_kind,unit_label:item.unit_label,quantity_decimals:item.quantity_decimals} : {}),
    })),
  })
  return sale
}

async function createSaleRecordAndStock(tx, { saleData, items, userId, companyId,allowArchivedServices=false }, deps = {}) {
  const sale=await insertSaleRecord(tx,{saleData,items,userId})
  await (deps.moveStock || moveSaleStock)(tx, items, saleData.branch_id, {
    reason: 'SALE', refType: 'sale', refId: sale.id, userId, companyId,allowArchivedServices,
  })
  return sale
}

async function createReplacementSale(tx, {
  returnRecord,
  replacements,
  companyId,
  userId,
  pricing = 'CURRENT_PRICE',
  cashRegisterSessionId = null,
}, deps = {}) {
  if (returnRecord.replacement_sale_id) {
    const previous = await tx.sale.findUnique({ where: { id: returnRecord.replacement_sale_id } })
    if (previous) {
      return {
        sale: previous,
        total: Number(previous.total),
        difference: exchangeDifference(returnRecord.total_refund, previous.total),
        _idempotent: true,
      }
    }
  }

  const items = await resolvePricedSaleItems(tx, {
    items: replacements,
    branchId: returnRecord.sale.branch_id,
    companyId,
    customerContactId: returnRecord.sale.customer_contact_id,
    salesChannel: returnRecord.sale.sales_channel,
    pricing,
    originalSaleItems: returnRecord.sale.sale_items,
    approvedSnapshots: returnRecord.replacement_items || [],
    availability: deps.availability || getAvailabilityBatchWithKits,
  })
  const total = items.reduce((sum,item)=>sum.add(String(item.line_total)),new Prisma.Decimal(0)).toNumber()
  const status = await tx.saleStatus.findFirst({ where: { name: 'Completada' } })
  if (!status) fail('Estado de venta Completada no configurado', 409)
  const branch = await tx.branch.findUnique({
    where: { id: returnRecord.sale.branch_id },
    select: { id: true, code: true, seq: true },
  })
  if (!branch) fail('Sucursal de la venta original no encontrada', 404)
  const reference = await (deps.nextReference || nextDocumentReference)(tx, 'V', branch)
  const now = new Date()
  const sale = await createSaleRecordAndStock(tx, {
    userId,
    companyId,
    items,
    saleData: {
      branch_id: branch.id,
      reference,
      date: now,
      sold_at: now,
      customer: returnRecord.sale.customer,
      customer_nit: returnRecord.sale.customer_nit,
      is_final_consumer: returnRecord.sale.is_final_consumer,
      customer_contact_id: returnRecord.sale.customer_contact_id,
      sales_channel: returnRecord.sale.sales_channel,
      payment_method_id: returnRecord.sale.payment_method_id,
      payment_status: 'PAID',
      status_id: status.id,
      cash_register_session_id: cashRegisterSessionId,
      idempotency_key: `exchange:${returnRecord.id}`.slice(0, 64),
      items: items.filter(item=>item.item_kind!=='SERVICE').reduce((sum,item)=>sum+Number(item.qty),0),
      subtotal: total,
      discount_total: 0,
      total,
      adjusted_total: total,
      total_returned: 0,
    },
  }, deps)
  await tx.return.update({
    where: { id: returnRecord.id },
    data: {
      replacement_sale_id: sale.id,
      price_difference: round2(total - Number(returnRecord.total_refund)),
    },
  })
  return { sale, total, items, difference: exchangeDifference(returnRecord.total_refund, total) }
}

module.exports = {
  insertSaleRecord,
  moveSaleStock,
  createReplacementSale,
  createSaleRecordAndStock,
  exchangeDifference,
  exchangeSettlement,
  resolvePricedSaleItems,
}
