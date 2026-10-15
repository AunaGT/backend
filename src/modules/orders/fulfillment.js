const { randomUUID } = require('crypto')
const { resolveFulfillmentLines, isOrderFullyFulfilled, partialLineTotal } = require('../../services/commercialDocumentFulfillment')
const { assertLinesAvailable, consumePartialByDocument, releaseByDocument, reserveForDocument } = require('../../services/stockAvailability')
const { expandLinesToStockMap, deductStockMap, restoreStockMap } = require('../../services/bomStock')
const { consumeLotsFEFO, restoreLotsFEFO } = require('../../services/lots')
const { dispatchedByRef } = require('../../services/stockLocations')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const { nextDocumentReference } = require('../../services/referenceGenerator')
const { creditDueDate, initialPaymentAmount, recordInitialPayment, getTimezone } = require('../../services/commercialPayment')
const { checkCredit, lockCustomer, CUSTOMER_TERM_PICK } = require('../receivables')
const { getCompanyModuleBlock, readCompanyModules } = require('../platform/service')
const {Prisma}=require('@prisma/client')
const {lineSnapshot}=require('../../services/catalogItemRules')

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
    if (!item || seen.has(item.line_id)) {
      fail('Partidas repetidas o cantidades inválidas')
    }
    seen.add(item.line_id)
  }
  return resolveFulfillmentLines(invoice
    ? lines.map(line => ({ ...line, qty: line.qty_fulfilled, qty_fulfilled: line.qty_invoiced }))
    : lines, raw)
}

async function lockedOrder(tx, req, {separateOnly=true}={}) {
  // Both mutations serialize on the same row; load quantities only after locking.
  const rows = await tx.$queryRaw`
    SELECT d.id FROM commercial_documents d JOIN branches b ON b.id = d.branch_id
    WHERE (d.id::text = ${req.params.id} OR d.reference = ${req.params.id})
      AND d.doc_type = 'ORDER' AND b.company_id = ${req.companyId}::uuid
      AND d.branch_id = ${req.branchId}::uuid FOR UPDATE OF d`
  if (!rows.length) fail('Pedido no encontrado en la sucursal activa', 404)
  const order = await tx.commercialDocument.findUnique({ where: { id: rows[0].id }, include: { lines: {orderBy:{sort_order:'asc'}} } })
  if (separateOnly && order.fulfillment_mode !== 'SEPARATE') fail('Este pedido conserva el flujo anterior', 409)
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
  const stockLines = lines.map(({ line, qty }) => ({ ...line,product_id: line.product_id, qty }))
  await assertLinesAvailable(tx, stockLines, { excludeDocumentId: order.id, branchId: order.branch_id, companyId:req.companyId,allowArchivedServices:true })
  const physicalIds=lines.filter(({line})=>line.item_kind!=='SERVICE').map(({line})=>line.product_id)
  const productsAtDelivery = physicalIds.length ? await tx.product.findMany({ where: { id: { in: physicalIds },company_id:req.companyId }, select: { id: true, cost: true } }) : []
  const costs = new Map(productsAtDelivery.map(product => [product.id, product.cost]))
  const delivery = await tx.orderDelivery.create({ data: {
    document_id: order.id, request_key: key, created_by: req.user.sub, notes,
    lines: { create: lines.map(({ line_id, line, qty }) => ({ document_line_id: line_id, qty, unit_cost:line.item_kind==='SERVICE' ? 0 : costs.get(line.product_id) ?? null })) },
  }, include: { lines: true } })
  const stockMap = await expandLinesToStockMap(tx, stockLines, {companyId:req.companyId,allowArchivedServices:true})
  const groupId = randomUUID()
  const products = await deductStockMap(tx, stockMap, order.branch_id, {
    reason: 'ORDER_FULFILL', refType: 'order_delivery', refId: delivery.id, userId: req.user.sub, groupId,
  })
  if (stockMap.size) await consumeLotsFEFO(tx, stockMap, order.branch_id, await dispatchedByRef(tx, { groupId }))
  await ensureStockAlertsBatch(tx, products, order.branch_id)
  await consumePartialByDocument(tx, order.id, lines.map(({ line_id, qty }) => ({ line_id, qty })),{companyId:req.companyId})
  const updatedLines = await tx.commercialDocumentLine.findMany({ where: { document_id: order.id } })
  await tx.commercialDocument.update({ where: { id: order.id }, data: {
    status: isOrderFullyFulfilled(updatedLines) ? 'FULFILLED' : 'PARTIALLY_FULFILLED',
  } })
  return { orderId: order.id, delivery }
}

async function invoice(tx, req, requireCashSession, settlement=null) {
  const key = requestKey(req.body?.request_key)
  const order = await lockedOrder(tx, req)
  const engagement=await tx.appointmentEngagement.findFirst({where:{order_id:order.id,company_id:req.companyId},select:{id:true,commercial_snapshot:true}})
  const previouslyInvoiced=engagement?.commercial_snapshot?.orders?.some(source=>source.id===order.id&&source.documentSales?.length)
  if(engagement&&!previouslyInvoiced&&settlement?.engagementId!==engagement.id)throw Object.assign(new Error('Genera la venta desde la contratación vinculada de Agenda'),{status:409,code:'ENGAGEMENT_OWNS_SOURCE'})
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
  const originalLines = new Map(order.lines.map(line => [line.id, line]))
  const netLineTotals = lines.map(({line_id,qty}) => { const original=originalLines.get(line_id); return partialLineTotal(original,qty,original.qty_invoiced).toNumber() })
  const totalDecimal=netLineTotals.reduce((sum,amount)=>sum.add(amount),new Prisma.Decimal(0))
  if (totalDecimal.gte('10000000000')) fail('Total de factura fuera de rango')
  const total=totalDecimal.toNumber()
  const initialAmount = settlement?0:initialPaymentAmount(req.body, total, method.is_credit)
  const now = new Date()
  let dueDate = settlement?.dueDate||null
  let sessionId = null
  let received = null
  if(settlement){
    if(settlement.kind!=='EXISTING_RECEIPTS')fail('Liquidación interna inválida')
  } else if (method.is_credit) {
    const blocked = await getCompanyModuleBlock(req.companyId, 'receivables', companyId => readCompanyModules(companyId, tx, { useCache: false }))
    if (blocked) fail('Cartera no está disponible para esta empresa', 403)
    const setting = await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: req.companyId, key: 'sales_allow_credit' } } })
    if (String(setting?.value ?? 'true').toLowerCase() !== 'true') fail('Las ventas al crédito están desactivadas', 403)
    if (!order.customer_contact_id) fail('Selecciona un cliente para vender al crédito')
    const customer = await tx.supplier.findFirst({ where: { id: order.customer_contact_id, company_id: req.companyId }, select: {
      id: true, name: true, credit_limit: true, supplier_payment_terms: CUSTOMER_TERM_PICK,
    } })
    if (!customer) fail('Cliente no encontrado', 404)
    const days = order.payment_condition === 'CREDIT' ? order.credit_days : customer.supplier_payment_terms[0]?.payment_term?.net_days
    dueDate = creditDueDate(req.body.due_date, days, now, await getTimezone(tx, req.companyId))
    await lockCustomer(tx, customer.id)
    const credit = await checkCredit(tx, customer, round(total - initialAmount), { branch_id: order.branch_id })
    if (!credit.ok) fail(credit.motivo || 'El cliente no dispone de crédito', 409)
    if (initialAmount) sessionId = await requireCashSession(tx, req.user, req.body.cash_register_id, order.branch_id)
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
    let remaining = new Prisma.Decimal(qty)
    let cost = new Prisma.Decimal(0)
    let hasCost = false
    for (const item of deliveredLines.filter(item => item.document_line_id === line_id)) {
      const take = Prisma.Decimal.min(remaining,new Prisma.Decimal(String(item.qty)).sub(String(item.qty_invoiced || 0)))
      if (take.lte(0)) continue
      allocations.push({ id: item.id, qty: take })
      if (item.unit_cost != null) { cost=cost.add(take.mul(String(item.unit_cost))); hasCost = true }
      remaining=remaining.sub(take)
    }
    if (!remaining.eq(0)) fail('Las entregas no cubren las cantidades solicitadas', 409)
    costs.set(line_id, hasCost ? cost.div(qty).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toNumber() : null)
  }
  const physicalUnits=lines.filter(({line})=>line.item_kind!=='SERVICE').reduce((sum,{qty})=>sum+qty.toNumber(),0)
  if (physicalUnits>2147483647) fail('Cantidad física total fuera de rango')
  let sale
  if(settlement?.draftSaleId){
    await tx.$queryRaw`SELECT id FROM sales WHERE id=${settlement.draftSaleId}::uuid AND branch_id=${order.branch_id}::uuid FOR UPDATE`
    const draft=await tx.sale.findFirst({where:{id:settlement.draftSaleId,branch_id:order.branch_id,origin_engagement_id:settlement.engagementId,branch:{company_id:req.companyId}},include:{status:true,sale_items:{orderBy:{id:'asc'}}}})
    if(!draft||draft.status.name!=='Borrador'||!draft.total.eq(totalDecimal)||draft.sale_items.length!==lines.length)fail('El borrador no coincide con el pedido contratado',409)
    for(const [i,{line,qty}]of lines.entries()){
      const item=draft.sale_items[i]
      if(item.product_id!==line.product_id||item.item_kind!==line.item_kind||item.item_name!==line.item_name||item.unit_label!==line.unit_label||item.quantity_decimals!==line.quantity_decimals||!item.qty.eq(qty)||!item.price.eq(line.unit_price)||!item.net_total?.eq(netLineTotals[i]))fail('Las partidas del borrador cambiaron',409)
    }
    sale=await tx.sale.update({where:{id:draft.id,version:draft.version},data:{status_id:status.id,version:{increment:1},date:settlement.issuedAt,sold_at:settlement.issuedAt,confirmed_at:settlement.issuedAt,
      payment_method_id:method.id,payment_status:total===0?'PAID':'PENDING',due_date:dueDate,idempotency_key:key}})
    for(const [i,{line,line_id}]of lines.entries())await tx.saleItem.update({where:{id:draft.sale_items[i].id},data:{unit_cost:line.item_kind==='SERVICE'?0:costs.get(line_id)??null}})
    await tx.commercialDocumentSale.create({data:{document_id:order.id,sale_id:sale.id}})
    await tx.saleHistory.create({data:{company_id:req.companyId,branch_id:order.branch_id,sale_id:sale.id,actor_id:req.user.sub,action:'SALE_CONFIRMED',request_key:key,
      input_hash:require('node:crypto').createHash('sha256').update(`${settlement.engagementId}:${draft.version}`).digest('hex'),before:{state:'DRAFT'},after:{state:'CONFIRMED',orderId:order.id,engagementId:settlement.engagementId}}})
  }else sale = await tx.sale.create({ data: {
    branch_id: order.branch_id, reference: await nextDocumentReference(tx, 'V', branch),
    customer: order.customer, customer_nit: order.customer_nit, is_final_consumer: order.is_final_consumer,
    customer_contact_id: order.customer_contact_id, sales_channel: order.sales_channel,
    date: now, sold_at: now,confirmed_at:now, created_by: req.user.sub, status_id: status.id,
    payment_method_id: method.id, payment_status: method.is_credit ? 'PENDING' : 'PAID', due_date: dueDate,
    ...(settlement?{settlement_source:'ENGAGEMENT_RECEIPTS',payment_status:total===0?'PAID':'PENDING'}:{}),
    amount_received: received, change: received == null ? null : round(received - total),
    cash_register_session_id: sessionId, idempotency_key: key,
    items: physicalUnits, subtotal: total, discount_total: 0,
    total, adjusted_total: total, total_returned: 0,
    sale_items: { create: lines.map(({ line, line_id, qty }, index) => ({ product_id: line.product_id, qty, price: line.unit_price, unit_cost:line.item_kind==='SERVICE' ? 0 : costs.get(line_id) ?? null, net_total: netLineTotals[index],...lineSnapshot(line) })) },
    orderLink: { create: { document_id: order.id } },
  } })
  for (const { line_id, qty } of lines) {
    await tx.commercialDocumentLine.update({ where: { id: line_id }, data: { qty_invoiced: { increment: qty } } })
  }
  for (const allocation of allocations) {
    await tx.orderDeliveryLine.update({ where: { id: allocation.id }, data: { qty_invoiced: { increment: allocation.qty } } })
  }
  await recordInitialPayment(tx, req, sale, initialAmount, sessionId)
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
  const allServices=lines.every(line=>line.item_kind==='SERVICE')
  const dispatched = allServices ? new Map() : await dispatchedByRef(tx, { refType: 'order_delivery', refId: delivery.id, reason: 'ORDER_FULFILL' })
  const stockMap = new Map([...dispatched].map(([productId, locations]) => [productId, locations.reduce((sum, location) => sum + location.qty, 0)]))
  if (!stockMap.size && !allServices) fail('No se encontraron los movimientos originales de esta entrega', 409)
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
    await reserveForDocument(tx, { documentId: order.id, branchId: order.branch_id, companyId:req.companyId,allowArchivedServices:true, expiresAt: order.valid_until, createdBy: req.user.sub,
      documentLines: current.map(line => ({ ...line, qty: new Prisma.Decimal(String(line.qty)).sub(String(line.qty_fulfilled || 0)) })).filter(line => line.qty.gt(0)) })
  }
  await tx.commercialDocument.update({ where: { id: order.id }, data: { status: expired ? 'EXPIRED' : current.some(line => line.qty_fulfilled > 0) ? 'PARTIALLY_FULFILLED' : 'CONFIRMED' } })
  await tx.orderDelivery.update({ where: { id: delivery.id }, data: { reversed_at: new Date() } })
  return { orderId: order.id }
}

module.exports = { deliver, invoice, reverseDelivery, selectLines, requestKey,lockedOrder }
