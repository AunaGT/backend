const { round2 } = require('../../services/accounting/logic')
const { assertReturnTransition, normalizeReturnPolicy, RETURN_RESOLUTIONS } = require('./domain')
const { ensureStockAlertsBatch } = require('../../services/stockAlerts')
const { expandLinesToStockMap, restoreStockMap } = require('../../services/bomStock')
const { paidOf, releaseSaleOverpayment, syncSaleStatus } = require('../receivables/domain/receivables')

const STOCK_DISPOSITIONS = new Set(['SELLABLE', 'QUARANTINE'])
const DISPOSITIONS = new Set([...STOCK_DISPOSITIONS, 'SCRAP'])

function invalid(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function planReceivableReturn({ adjustedTotal, paid, refundAmount }) {
  const current = round2(adjustedTotal)
  const paidAmount = round2(paid)
  const refund = round2(refundAmount)
  const outstanding = round2(Math.max(0, current - paidAmount))
  const creditOffset = round2(Math.min(refund, outstanding))
  const refundable = round2(Math.max(0, refund - creditOffset))
  return {
    newAdjustedTotal: round2(Math.max(0, current - refund)),
    creditOffset,
    refundable,
    releaseApplications: round2(Math.min(refundable, paidAmount)),
  }
}

function buildCompletionPlan(returnRecord, payload = {}) {
  if (returnRecord?.status?.name !== 'Aprobada') {
    throw invalid('La devolución debe aprobarse antes de completarse', 409)
  }
  const key = String(payload.idempotency_key || '').trim()
  if (!key || key.length > 64) throw invalid('La clave de idempotencia es requerida y debe tener hasta 64 caracteres')

  const requested = Array.isArray(payload.lines) ? payload.lines : []
  const byId = new Map(requested.map((line) => [Number(line?.return_item_id), line]))
  if (requested.length !== returnRecord.return_items.length || byId.size !== requested.length) {
    throw invalid('Debe clasificar exactamente todas las líneas de la devolución')
  }

  const lines = returnRecord.return_items.map((item) => {
    const raw = byId.get(Number(item.id))
    if (!raw) throw invalid(`Falta clasificar la línea ${item.id}`)
    const receivedQty = Number(raw.received_qty)
    if (!Number.isInteger(receivedQty) || receivedQty !== Number(item.qty_returned)) {
      throw invalid('Para completar, la cantidad recibida debe coincidir con la cantidad aprobada')
    }
    const disposition = String(raw.disposition || '')
    if (!DISPOSITIONS.has(disposition)) throw invalid('El destino del producto devuelto no es válido')
    const stockLocationId = String(raw.stock_location_id || '').trim() || null
    if (STOCK_DISPOSITIONS.has(disposition) && !stockLocationId) {
      throw invalid('Debe indicar la ubicación de inventario para cada producto que reingresa')
    }
    return {
      return_item_id: Number(item.id),
      product_id: String(item.product_id),
      received_qty: receivedQty,
      restock_qty: disposition === 'SCRAP' ? 0 : receivedQty,
      disposition,
      stock_location_id: disposition === 'SCRAP' ? null : stockLocationId,
    }
  })

  const totalReturned = round2(Number(returnRecord.sale.total_returned || 0) + Number(returnRecord.total_refund))
  return {
    idempotency_key: key,
    resolution: returnRecord.approved_resolution,
    lines,
    settlement: payload.settlement || {},
    saleAdjustment: {
      total_returned: totalReturned,
      adjusted_total: round2(Math.max(0, Number(returnRecord.sale.total) - totalReturned)),
    },
  }
}

function normalizeApprovalLines(returnRecord, lines) {
  const requested = Array.isArray(lines) ? lines : []
  const byId = new Map(requested.map((line) => [Number(line?.return_item_id), line]))
  if (requested.length !== returnRecord.return_items.length || byId.size !== requested.length) {
    throw invalid('Debe clasificar exactamente todas las líneas de la devolución')
  }
  return returnRecord.return_items.map((item) => {
    const raw = byId.get(Number(item.id))
    if (!raw) throw invalid(`Falta clasificar la línea ${item.id}`)
    const disposition = String(raw.disposition || '')
    if (!DISPOSITIONS.has(disposition)) throw invalid('El destino del producto devuelto no es válido')
    const stockLocationId = String(raw.stock_location_id || '').trim() || null
    if (STOCK_DISPOSITIONS.has(disposition) && !stockLocationId) {
      throw invalid('Debe indicar la ubicación prevista para el producto devuelto')
    }
    return {
      return_item_id: Number(item.id),
      disposition,
      stock_location_id: disposition === 'SCRAP' ? null : stockLocationId,
    }
  })
}

async function assertDispositionLocations(tx, branchId, lines) {
  const ids = [...new Set(lines.map((line) => line.stock_location_id).filter(Boolean))]
  if (ids.length === 0) return
  const rows = await tx.stockLocation.findMany({
    where: { id: { in: ids }, active: true, warehouse: { branch_id: branchId, active: true } },
    select: { id: true, pickable: true },
  })
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  for (const line of lines) {
    if (!line.stock_location_id) continue
    const location = byId.get(line.stock_location_id)
    if (!location) throw invalid('Una ubicación no pertenece a la sucursal o está inactiva', 403)
    if (line.disposition === 'SELLABLE' && !location.pickable) {
      throw invalid('Un producto vendible debe ingresar a una ubicación despachable')
    }
    if (line.disposition === 'QUARANTINE' && location.pickable) {
      throw invalid('Cuarentena requiere una ubicación no despachable')
    }
  }
}

async function approveReturn(tx, { id, scope, userId, resolution, lines, policy }) {
  await tx.$queryRaw`SELECT id FROM returns WHERE id = ${id}::uuid FOR UPDATE`
  const current = await tx.return.findFirst({
    where: { id, sale: { ...scope } },
    include: { status: true, sale: { select: { branch_id: true } }, return_items: true },
  })
  if (!current) throw invalid('Devolución no encontrada', 404)
  assertReturnTransition(current.status.name, 'Aprobada')

  const approvedResolution = String(resolution || current.requested_resolution || '')
  if (!RETURN_RESOLUTIONS.includes(approvedResolution)) throw invalid('La solución aprobada no es válida')
  if (!normalizeReturnPolicy(policy).enabledResolutions.includes(approvedResolution)) {
    throw invalid('La solución aprobada está deshabilitada por la política de la empresa', 409)
  }
  const plannedLines = normalizeApprovalLines(current, lines)
  await assertDispositionLocations(tx, current.sale.branch_id, plannedLines)

  const approvedStatus = await tx.returnStatus.findFirst({ where: { name: 'Aprobada' } })
  if (!approvedStatus) throw invalid('Estado "Aprobada" no encontrado', 500)
  const approvedAt = new Date()
  const updated = await tx.return.update({
    where: { id },
    data: {
      status_id: approvedStatus.id,
      approved_resolution: approvedResolution,
      approved_by: userId,
      approved_at: approvedAt,
      version: { increment: 1 },
    },
    include: { status: true, sale: true, return_items: true, settlements: true },
  })
  for (const line of plannedLines) {
    await tx.returnItem.update({
      where: { id: line.return_item_id },
      data: { disposition: line.disposition, stock_location_id: line.stock_location_id },
    })
  }
  return updated
}

async function restoreDispositionStock(tx, lines, branchId, ctx) {
  const groups = new Map()
  for (const line of lines.filter((item) => item.restock_qty > 0)) {
    if (!groups.has(line.stock_location_id)) groups.set(line.stock_location_id, [])
    groups.get(line.stock_location_id).push({ product_id: line.product_id, qty: line.restock_qty })
  }
  const updated = []
  for (const [locationId, stockLines] of groups) {
    const stockMap = await expandLinesToStockMap(tx, stockLines)
    updated.push(...await restoreStockMap(tx, stockMap, branchId, { ...ctx, locationId }))
  }
  await ensureStockAlertsBatch(tx, updated, branchId)
  return updated
}

async function validateDirectSettlement(tx, current, resolution, settlement, amount) {
  if (amount <= 0) return { paymentMethodId: null, cashSessionId: null, externalReference: null }
  let paymentMethodId = Number(settlement.payment_method_id)
  if (resolution === 'REFUND_ORIGINAL' && !Number.isInteger(paymentMethodId)) {
    paymentMethodId = Number(current.sale.payment_method?.id)
  }
  if (!Number.isInteger(paymentMethodId)) throw invalid('Debe indicar el método real del reintegro')
  const method = await tx.paymentMethod.findUnique({ where: { id: paymentMethodId }, select: { id: true, name: true, is_credit: true } })
  if (!method || method.is_credit) throw invalid('El método de reintegro no es válido')

  const externalReference = String(settlement.external_reference || '').trim() || null
  if (resolution === 'REFUND_TRANSFER' && !externalReference) {
    throw invalid('La transferencia de reintegro requiere una referencia')
  }
  const isCash = resolution === 'REFUND_CASH' || /efectivo|cash/i.test(method.name)
  const cashSessionId = String(settlement.cash_register_session_id || '').trim() || null
  if (isCash && !cashSessionId) throw invalid('El reintegro en efectivo requiere una sesión de caja abierta')
  if (cashSessionId) {
    const session = await tx.cashRegisterSession.findFirst({
      where: { id: cashSessionId, status: 'OPEN', cashRegister: { branch_id: current.sale.branch_id } },
      select: { id: true },
    })
    if (!session) throw invalid('La sesión de caja no está abierta en la sucursal de la venta', 409)
  }
  return { paymentMethodId, cashSessionId, externalReference: externalReference?.slice(0, 255) || null }
}

async function completeApprovedReturn(tx, { id, scope, userId, payload }, deps = {}) {
  const key = String(payload?.idempotency_key || '').trim()
  if (!key || key.length > 64) throw invalid('La clave de idempotencia es requerida y debe tener hasta 64 caracteres')
  await tx.$queryRaw`SELECT id FROM returns WHERE id = ${id}::uuid FOR UPDATE`
  const current = await tx.return.findFirst({
    where: { id, sale: { ...scope } },
    include: {
      status: true,
      return_items: true,
      sale: {
        include: {
          payment_method: true,
          paymentEntries: { select: { id: true, amount: true, created_at: true } },
        },
      },
    },
  })
  if (!current) throw invalid('Devolución no encontrada', 404)

  const existing = await tx.returnSettlement.findFirst({
    where: { return_id: id, idempotency_key: key },
  })
  if (existing) return { ...current, _idempotent: true, _settlement: existing }
  if (current.legacy_stock_moved === true && current.legacy_stock_reconciled !== true) {
    throw invalid('Esta devolución histórica requiere conciliar el movimiento de inventario antes de completarse', 409)
  }

  const plan = buildCompletionPlan(current, payload)
  if (plan.resolution === 'EXCHANGE') {
    throw invalid('El cambio de producto debe generar primero su venta vinculada', 409)
  }
  await assertDispositionLocations(tx, current.sale.branch_id, plan.lines)

  const isCreditSale = current.sale.payment_method?.is_credit === true
  const paid = isCreditSale ? paidOf(current.sale) : Number(current.sale.adjusted_total)
  const receivable = isCreditSale
    ? planReceivableReturn({ adjustedTotal: current.sale.adjusted_total, paid, refundAmount: current.total_refund })
    : {
        newAdjustedTotal: plan.saleAdjustment.adjusted_total,
        creditOffset: 0,
        refundable: round2(current.total_refund),
        releaseApplications: 0,
      }
  if (plan.resolution === 'CUSTOMER_CREDIT' && receivable.refundable > 0 && !current.sale.customer_contact_id) {
    throw invalid('La venta no tiene un cliente maestro al cual asignar el saldo a favor', 409)
  }
  const direct = plan.resolution === 'CUSTOMER_CREDIT'
    ? { paymentMethodId: null, cashSessionId: null, externalReference: null }
    : await validateDirectSettlement(tx, current, plan.resolution, plan.settlement, receivable.refundable)

  const restoreStock = deps.restoreStock || restoreDispositionStock
  const ensureAlerts = deps.ensureAlerts
  const stockResult = current.legacy_stock_moved === true
    ? []
    : await restoreStock(tx, plan.lines, current.sale.branch_id, {
        reason: 'SALE_RETURN', refType: 'return', refId: id, userId,
      })
  if (ensureAlerts) await ensureAlerts(tx, stockResult, current.sale.branch_id)

  await tx.sale.update({
    where: { id: current.sale.id },
    data: plan.saleAdjustment,
  })
  if (isCreditSale && receivable.releaseApplications > 0) {
    await releaseSaleOverpayment(tx, current.sale.id, receivable.releaseApplications)
  } else if (isCreditSale) {
    await syncSaleStatus(tx, current.sale.id)
  }

  for (const line of plan.lines) {
    await tx.returnItem.update({
      where: { id: line.return_item_id },
      data: {
        received_qty: line.received_qty,
        restock_qty: line.restock_qty,
        disposition: line.disposition,
        stock_location_id: line.stock_location_id,
      },
    })
  }

  if (plan.resolution === 'CUSTOMER_CREDIT' && receivable.refundable > 0 && !isCreditSale) {
    await tx.customerPayment.create({
      data: {
        branch_id: current.sale.branch_id,
        customer_id: current.sale.customer_contact_id,
        amount: receivable.refundable,
        kind: 'CREDIT_NOTE',
        reference: current.reference || null,
        notes: `Saldo a favor por devolución ${current.reference || current.id}`,
        registered_by: userId,
      },
    })
  }

  const settlementKind = receivable.refundable > 0
    ? (plan.resolution === 'CUSTOMER_CREDIT' ? 'CUSTOMER_CREDIT' : 'REFUND')
    : 'CREDIT_OFFSET'
  const settlementAmount = receivable.refundable > 0 ? receivable.refundable : receivable.creditOffset
  const settlement = await tx.returnSettlement.create({
    data: {
      return_id: id,
      kind: settlementKind,
      amount: settlementAmount,
      payment_method_id: direct.paymentMethodId,
      cash_register_session_id: direct.cashSessionId,
      external_reference: direct.externalReference,
      registered_by: userId,
      idempotency_key: key,
    },
  })
  if (receivable.refundable > 0 && receivable.creditOffset > 0) {
    await tx.returnSettlement.create({
      data: {
        return_id: id,
        kind: 'CREDIT_OFFSET',
        amount: receivable.creditOffset,
        registered_by: userId,
        idempotency_key: `${key.slice(0, 53)}:offset`,
      },
    })
  }

  const completedStatus = await tx.returnStatus.findFirst({ where: { name: 'Completada' } })
  if (!completedStatus) throw invalid('Estado "Completada" no encontrado', 500)
  const updated = await tx.return.update({
    where: { id },
    data: {
      status_id: completedStatus.id,
      processed_by: userId,
      processed_at: new Date(),
      version: { increment: 1 },
    },
    include: { status: true, sale: true, return_items: true, settlements: true },
  })
  return {
    ...updated,
    _settlement: settlement,
    _effects: {
      stock_units: plan.lines.reduce((sum, line) => sum + line.restock_qty, 0),
      credit_offset: receivable.creditOffset,
      refunded: plan.resolution === 'CUSTOMER_CREDIT' ? 0 : receivable.refundable,
      customer_credit: plan.resolution === 'CUSTOMER_CREDIT' ? receivable.refundable : 0,
    },
  }
}

function completeReturn(client, params, deps) {
  return client.$transaction((tx) => completeApprovedReturn(tx, params, deps), {
    maxWait: 10000,
    timeout: 15000,
  })
}

module.exports = {
  approveReturn,
  buildCompletionPlan,
  completeApprovedReturn,
  completeReturn,
  planReceivableReturn,
}
