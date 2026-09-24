const { randomUUID } = require('crypto')
const { resolveFulfillmentLines, isOrderFullyFulfilled } = require('../../services/commercialDocumentFulfillment')
const { assertLinesAvailable, consumePartialByDocument, releaseByDocument, reserveForDocument } = require('../../services/stockAvailability')
const { expandLinesToStockMap, deductStockMap, restoreStockMap } = require('../../services/bomStock')
const { consumeLotsFEFO, restoreLotsFEFO } = require('../../services/lots')
const { dispatchedByRef } = require('../../services/stockLocations')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const { nextDocumentReference } = require('../../services/referenceGenerator')
const { checkCredit, lockCustomer, CUSTOMER_TERM_PICK } = require('../receivables')
const { getCompanyModuleBlock, readCompanyModules } = require('../platform/service')

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }

function requestKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail('La operación necesita una clave de intento válida')
  }
  return value
}

function selectLines(lines, raw, invoice = false) {
  if (!Array.isArray(raw) || !raw.length) fail('Selecciona al menos una partida')
  const seen = new Set()
  for (const item of raw) {
    if (!item || seen.has(item.line_id) || !Number.isSafeInteger(item.qty) || item.qty <= 0) {
      fail('Partidas repetidas o cantidades inválidas')
    }
    seen.add(item.line_id)
  }
  return resolveFulfillmentLines(invoice
    ? lines.map(line => ({ ...line, qty: line.qty_fulfilled, qty_fulfilled: line.qty_invoiced }))
    : lines, raw)
}

async function lockedOrder(tx, req) {
  // Both mutations serialize on the same row; load quantities only after locking.
  const rows = await tx.$queryRaw`
    SELECT d.id FROM commercial_documents d JOIN branches b ON b.id = d.branch_id
    WHERE (d.id::text = ${req.params.id} OR d.reference = ${req.params.id})
      AND d.doc_type = 'ORDER' AND b.company_id = ${req.companyId}::uuid
      AND d.branch_id = ${req.branchId}::uuid FOR UPDATE OF d`
  if (!rows.length) fail('Pedido no encontrado en la sucursal activa', 404)
  const order = await tx.commercialDocument.findUnique({ where: { id: rows[0].id }, include: { lines: true } })
  if (order.fulfillment_mode !== 'SEPARATE') fail('Este pedido conserva el flujo anterior', 409)
  return order
}

async function deliver(tx, req) {
  const key = requestKey(req.body?.request_key)
  const order = await lockedOrder(tx, req)
  const previous = await tx.orderDelivery.findUnique({ where: { document_id_request_key: { document_id: order.id, request_key: key } }, include: { lines: true } })
  if (previous) return { orderId: order.id, delivery: previous }
  if (!['CONFIRMED', 'PARTIALLY_FULFILLED'].includes(order.status)) fail('El pedido no admite entregas', 409)
  if (order.valid_until && new Date(order.valid_until) < new Date()) fail('El pedido está vencido', 409)
  const lines = selectLines(order.lines, req.body.lines)
  const notes = req.body.notes == null ? null : String(req.body.notes).trim()
  if (notes?.length > 1000) fail('Las notas exceden 1000 caracteres')
  const stockLines = lines.map(({ line, qty }) => ({ product_id: line.product_id, qty }))
  await assertLinesAvailable(tx, stockLines, { excludeDocumentId: order.id, branchId: order.branch_id })
  const productsAtDelivery = await tx.product.findMany({ where: { id: { in: stockLines.map(line => line.product_id) } }, select: { id: true, cost: true } })
  const costs = new Map(productsAtDelivery.map(product => [product.id, product.cost]))
  const delivery = await tx.orderDelivery.create({ data: {
    document_id: order.id, request_key: key, created_by: req.user.sub, notes,
    lines: { create: lines.map(({ line_id, line, qty }) => ({ document_line_id: line_id, qty, unit_cost: costs.get(line.product_id) ?? null })) },
  }, include: { lines: true } })
  const stockMap = await expandLinesToStockMap(tx, stockLines)
  const groupId = randomUUID()
  const products = await deductStockMap(tx, stockMap, order.branch_id, {
    reason: 'ORDER_FULFILL', refType: 'order_delivery', refId: delivery.id, userId: req.user.sub, groupId,
  })
  await consumeLotsFEFO(tx, stockMap, order.branch_id, await dispatchedByRef(tx, { groupId }))
  await ensureStockAlertsBatch(tx, products, order.branch_id)
  await consumePartialByDocument(tx, order.id, lines.map(({ line_id, qty }) => ({ line_id, qty })))
  const updatedLines = await tx.commercialDocumentLine.findMany({ where: { document_id: order.id } })
  await tx.commercialDocument.update({ where: { id: order.id }, data: {
    status: isOrderFullyFulfilled(updatedLines) ? 'FULFILLED' : 'PARTIALLY_FULFILLED',
  } })
  return { orderId: order.id, delivery }
}

async function invoice(tx, req, requireCashSession) {
  const key = requestKey(req.body?.request_key)
  const order = await lockedOrder(tx, req)
  const previous = await tx.sale.findFirst({ where: {
    branch_id: order.branch_id, idempotency_key: key,
  }, include: { orderLink: true } })
  if (previous) {
    if (previous.orderLink?.document_id !== order.id) fail('Clave de intento utilizada por otra venta', 409)
    return { orderId: order.id, sale: previous }
  }
  if (!['CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'EXPIRED'].includes(order.status)) fail('El pedido no admite facturación', 409)
  const lines = selectLines(order.lines, req.body.lines, true)
  const method = await tx.paymentMethod.findUnique({ where: { id: Number(req.body.payment_method_id) || 0 } })
  if (!method) fail('Método de pago inválido')
  const round = value => Math.round(value * 100) / 100
  const total = round(lines.reduce((sum, { line, qty }) => sum + Number(line.unit_price) * qty, 0))
  const now = new Date()
  let dueDate = null
  let sessionId = null
  let received = null
  if (method.is_credit) {
    const blocked = await getCompanyModuleBlock(req.companyId, 'receivables', companyId => readCompanyModules(companyId, tx, { useCache: false }))
    if (blocked) fail('Cartera no está disponible para esta empresa', 403)
    const setting = await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: req.companyId, key: 'sales_allow_credit' } } })
    if (String(setting?.value ?? 'true').toLowerCase() !== 'true') fail('Las ventas al crédito están desactivadas', 403)
    if (!order.customer_contact_id) fail('Selecciona un cliente para vender al crédito')
    const customer = await tx.supplier.findFirst({ where: { id: order.customer_contact_id, company_id: req.companyId }, select: {
      id: true, name: true, credit_limit: true, supplier_payment_terms: CUSTOMER_TERM_PICK,
    } })
    if (!customer) fail('Cliente no encontrado', 404)
    const days = customer.supplier_payment_terms[0]?.payment_term?.net_days
    dueDate = req.body.due_date ? new Date(req.body.due_date) : days != null ? new Date(now.getTime() + Number(days) * 86400000) : null
    if (!dueDate || Number.isNaN(dueDate.getTime())) fail('Indica la fecha de vencimiento del crédito')
    await lockCustomer(tx, customer.id)
    const credit = await checkCredit(tx, customer, total, { branch_id: order.branch_id })
    if (!credit.ok) fail(credit.motivo || 'El cliente no dispone de crédito', 409)
  } else {
    sessionId = await requireCashSession(tx, req.user, req.body.cash_register_id, order.branch_id)
    received = req.body.amount_received == null ? total : Number(req.body.amount_received)
    if (!Number.isFinite(received) || received < total) fail('El monto recibido debe cubrir la venta; usa crédito para dejar saldo pendiente')
  }
  const status = await tx.saleStatus.findFirst({ where: { name: 'Completada' } })
  if (!status) fail('Estado de venta no configurado', 409)
  const branch = await tx.branch.findUnique({ where: { id: order.branch_id }, select: { id: true, code: true, seq: true } })
  const deliveredLines = await tx.orderDeliveryLine.findMany({ where: { delivery: { document_id: order.id, reversed_at: null } }, orderBy: [{ delivery: { created_at: 'asc' } }, { id: 'asc' }] })
  const allocations = []
  const costs = new Map()
  for (const { line_id, qty } of lines) {
    let remaining = qty
    let cost = 0
    let hasCost = false
    for (const item of deliveredLines.filter(item => item.document_line_id === line_id)) {
      const take = Math.min(remaining, item.qty - item.qty_invoiced)
      if (take <= 0) continue
      allocations.push({ id: item.id, qty: take })
      if (item.unit_cost != null) { cost += Number(item.unit_cost) * take; hasCost = true }
      remaining -= take
    }
    if (remaining) fail('Las entregas no cubren las cantidades solicitadas', 409)
    costs.set(line_id, hasCost ? round(cost / qty) : null)
  }
  const sale = await tx.sale.create({ data: {
    branch_id: order.branch_id, reference: await nextDocumentReference(tx, 'V', branch),
    customer: order.customer, customer_nit: order.customer_nit, is_final_consumer: order.is_final_consumer,
    customer_contact_id: order.customer_contact_id, sales_channel: order.sales_channel,
    date: now, sold_at: now, created_by: req.user.sub, status_id: status.id,
    payment_method_id: method.id, payment_status: method.is_credit ? 'PENDING' : 'PAID', due_date: dueDate,
    amount_received: received, change: received == null ? null : round(received - total),
    cash_register_session_id: sessionId, idempotency_key: key,
    items: lines.reduce((sum, line) => sum + line.qty, 0), subtotal: total, discount_total: 0,
    total, adjusted_total: total, total_returned: 0,
    sale_items: { create: lines.map(({ line, line_id, qty }) => ({ product_id: line.product_id, qty, price: line.unit_price, unit_cost: costs.get(line_id) ?? null })) },
    orderLink: { create: { document_id: order.id } },
  } })
  for (const { line_id, qty } of lines) {
    await tx.commercialDocumentLine.update({ where: { id: line_id }, data: { qty_invoiced: { increment: qty } } })
  }
  for (const allocation of allocations) {
    await tx.orderDeliveryLine.update({ where: { id: allocation.id }, data: { qty_invoiced: { increment: allocation.qty } } })
  }
  // Inventory was consumed by deliveries; invoicing must never deduct it again.
  return { orderId: order.id, sale }
}

async function reverseDelivery(tx, req) {
  const order = await lockedOrder(tx, req)
  const delivery = await tx.orderDelivery.findFirst({ where: { id: req.params.deliveryId, document_id: order.id }, include: { lines: true } })
  if (!delivery) fail('Entrega no encontrada', 404)
  if (delivery.reversed_at) return { orderId: order.id, delivery }
  if (delivery.lines.some(line => line.qty_invoiced > 0)) fail('La entrega tiene ventas emitidas. Corrige los productos mediante Devoluciones.', 409)
  const lines = delivery.lines.map(item => ({ ...order.lines.find(line => line.id === item.document_line_id), qty: item.qty }))
  const dispatched = await dispatchedByRef(tx, { refType: 'order_delivery', refId: delivery.id, reason: 'ORDER_FULFILL' })
  const stockMap = new Map([...dispatched].map(([productId, locations]) => [productId, locations.reduce((sum, location) => sum + location.qty, 0)]))
  if (!stockMap.size) fail('No se encontraron los movimientos originales de esta entrega', 409)
  const products = await restoreStockMap(tx, stockMap, order.branch_id, { reason: 'SALE_RETURN', refType: 'order_delivery', refId: delivery.id, userId: req.user.sub })
  await restoreLotsFEFO(tx, stockMap, order.branch_id)
  await ensureStockAlertsBatch(tx, products, order.branch_id)
  for (const line of lines) {
    await tx.commercialDocumentLine.update({ where: { id: line.id }, data: { qty_fulfilled: { decrement: line.qty } } })
  }
  const current = await tx.commercialDocumentLine.findMany({ where: { document_id: order.id } })
  await releaseByDocument(tx, order.id)
  const expired = order.valid_until && new Date(order.valid_until) < new Date()
  if (!expired) {
    await reserveForDocument(tx, { documentId: order.id, branchId: order.branch_id, expiresAt: order.valid_until, createdBy: req.user.sub,
      documentLines: current.map(line => ({ ...line, qty: line.qty - line.qty_fulfilled })).filter(line => line.qty > 0) })
  }
  await tx.commercialDocument.update({ where: { id: order.id }, data: { status: expired ? 'EXPIRED' : current.some(line => line.qty_fulfilled > 0) ? 'PARTIALLY_FULFILLED' : 'CONFIRMED' } })
  await tx.orderDelivery.update({ where: { id: delivery.id }, data: { reversed_at: new Date() } })
  return { orderId: order.id }
}

module.exports = { deliver, invoice, reverseDelivery, selectLines, requestKey }
