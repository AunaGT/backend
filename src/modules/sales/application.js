const { round2 } = require('../../services/accounting/logic')
const { randomUUID } = require('crypto')
const { getAvailabilityBatchWithKits, expandLinesToStockMap, deductStockMap } = require('../../services/bomStock')
const { resolvePriceTierForContext, resolveUnitPriceFromProduct } = require('../../services/priceResolution')
const { consumeLotsFEFO } = require('../../services/lots')
const { dispatchedByRef } = require('../../services/stockLocations')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const { nextDocumentReference } = require('../../services/referenceGenerator')
const { allocateNetLineTotals } = require('../../services/saleLineTotals')

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
  allowPriceOverride = false,
  availability = getAvailabilityBatchWithKits,
}) {
  if (!Array.isArray(items) || items.length === 0) fail('Selecciona al menos un producto de reemplazo')
  const qtyByProduct = new Map()
  for (const raw of items) {
    const id = String(raw?.product_id || '')
    const qty = Number(raw?.qty)
    if (!id || !Number.isInteger(qty) || qty <= 0) fail('Cada reemplazo requiere producto y cantidad entera mayor a cero')
    if (!allowPriceOverride && (raw.unit_price != null || raw.price != null)) {
      fail('El precio enviado por el navegador no está autorizado')
    }
    qtyByProduct.set(id, (qtyByProduct.get(id) || 0) + qty)
  }
  const ids = [...qtyByProduct.keys()]
  const products = await tx.product.findMany({
    where: { id: { in: ids }, company_id: companyId, deleted: false },
    select: {
      id: true, name: true, available_for_sale: true, price: true, price_wholesale: true,
      price_promotion: true, promotion_valid_until: true, cost: true,
    },
  })
  const byId = new Map(products.map((product) => [String(product.id), product]))
  const stock = await availability(ids, tx, branchId)
  const tier = await resolvePriceTierForContext(tx, { customerContactId, salesChannel })
  const historical = new Map(originalSaleItems.map((line) => [String(line.product_id), line]))
  const now = new Date()

  return items.map((raw) => {
    const productId = String(raw.product_id)
    const product = byId.get(productId)
    if (!product || !product.available_for_sale) fail(`Producto de reemplazo no encontrado o no disponible: ${productId}`)
    const qty = Number(raw.qty)
    const available = Number(stock[productId]?.available ?? 0)
    if (qtyByProduct.get(productId) > available) {
      fail(`Stock insuficiente para ${product.name}. Disponible: ${available}`, 409)
    }
    const source = historical.get(productId)
    const historicalPrice = source && Number(source.qty) > 0
      ? Number(source.net_total ?? Number(source.price) * Number(source.qty)) / Number(source.qty)
      : null
    const override = allowPriceOverride ? Number(raw.unit_price ?? raw.price) : null
    if (allowPriceOverride && raw.unit_price != null && (!Number.isFinite(override) || override < 0)) {
      fail('El precio autorizado no es válido')
    }
    const unitPrice = round2(Number.isFinite(override)
      ? override
      : pricing === 'ORIGINAL_SALE_PRICE' && Number.isFinite(historicalPrice)
        ? historicalPrice
        : resolveUnitPriceFromProduct(product, tier, now))
    return {
      product_id: productId,
      qty,
      unit_price: unitPrice,
      line_total: round2(unitPrice * qty),
      unit_cost: product.cost == null ? null : Number(product.cost),
    }
  })
}

async function moveSaleStock(tx, items, branchId, ctx) {
  const stockMap = await expandLinesToStockMap(tx, items.map((item) => ({ product_id: item.product_id, qty: item.qty })))
  const groupId = randomUUID()
  const products = await deductStockMap(tx, stockMap, branchId, { ...ctx, groupId })
  await consumeLotsFEFO(tx, stockMap, branchId, await dispatchedByRef(tx, { groupId }))
  await ensureStockAlertsBatch(tx, products, branchId)
  return products
}

async function createSaleRecordAndStock(tx, { saleData, items, userId }, deps = {}) {
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
    })),
  })
  await (deps.moveStock || moveSaleStock)(tx, items, saleData.branch_id, {
    reason: 'SALE', refType: 'sale', refId: sale.id, userId,
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
    availability: deps.availability || getAvailabilityBatchWithKits,
  })
  const total = round2(items.reduce((sum, item) => sum + item.line_total, 0))
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
      items: items.reduce((sum, item) => sum + item.qty, 0),
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
  createReplacementSale,
  createSaleRecordAndStock,
  exchangeDifference,
  exchangeSettlement,
  resolvePricedSaleItems,
}
