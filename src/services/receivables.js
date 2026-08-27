/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Cuentas por cobrar: saldo de una venta al crédito, aplicación FIFO de un
 * cobro y control de límite de crédito.
 *
 * El saldo NO se guarda en ninguna columna: es `adjusted_total − Σ abonos`.
 * Se usa `adjusted_total` y no `total` porque ya viene neteado de devoluciones,
 * así que devolver mercadería de una venta al crédito baja la deuda sola.
 * `sales.payment_status` es solo denormalización para poder filtrar e indexar.
 */

const { round2 } = require('./accounting/logic')

/** Mismo epsilon que compras: por debajo de medio centavo se considera saldado. */
const ROUND_EPS = 0.005

/**
 * Espacio de advisory locks de cartera. Se serializa por cliente para que dos
 * cobros simultáneos no lean el mismo saldo y apliquen de más (dejando la venta
 * con abonos por encima de su total). Se libera solo al terminar la transacción.
 */
const RECEIVABLE_LOCK_NS = 910005

async function lockCustomer(tx, customerId) {
  // Los casts son obligatorios: Prisma manda los parámetros como bigint y la
  // variante de dos claves de pg_advisory_xact_lock solo existe para int4.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECEIVABLE_LOCK_NS}::int4, hashtext(${customerId})::int4)`
}

class ReceivableError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message)
    this.name = 'ReceivableError'
    this.status = status
    if (details) this.details = details
  }
}

/** Estado de cobro según el total de la venta y lo abonado. */
function statusFor(total, paid) {
  if (paid >= total - ROUND_EPS) return 'PAID'
  if (paid > ROUND_EPS) return 'PARTIAL'
  return 'PENDING'
}

/** Suma de los abonos aplicados a una venta. */
function paidOf(sale) {
  return round2((sale.paymentEntries || []).reduce((s, e) => s + Number(e.amount), 0))
}

/** Saldo pendiente de una venta: lo que debe menos lo que ya abonó. */
function balanceOf(sale) {
  return round2(Number(sale.adjusted_total) - paidOf(sale))
}

/**
 * Reparte `amount` entre las ventas abiertas, de la más vieja a la más nueva.
 * `openSales` debe venir ya ordenada y con `{ id, balance }`.
 *
 * Devuelve `[{ sale_id, amount }]`. Rechaza el sobrepago en vez de inventar un
 * saldo a favor, igual que hace compras con sus abonos.
 */
function planFifo(openSales, amount) {
  let remaining = round2(amount)
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new ReceivableError('El monto del cobro debe ser mayor a 0')
  }
  const deuda = round2(openSales.reduce((s, v) => s + v.balance, 0))
  if (deuda <= 0) {
    throw new ReceivableError('El cliente no tiene saldo pendiente')
  }
  if (remaining > deuda + ROUND_EPS) {
    throw new ReceivableError(
      `El cobro excede el saldo del cliente (pendiente ${deuda.toFixed(2)})`,
      400,
      { saldo_pendiente: deuda, monto: remaining }
    )
  }

  const applications = []
  for (const sale of openSales) {
    if (remaining <= ROUND_EPS) break
    const take = round2(Math.min(remaining, sale.balance))
    if (take <= 0) continue
    applications.push({ sale_id: sale.id, amount: take })
    remaining = round2(remaining - take)
  }
  return applications
}

/**
 * Ventas al crédito abiertas de un cliente, de la más vieja a la más nueva.
 * El orden es el que consume el FIFO: primero la que vence antes; las que no
 * tienen vencimiento van por fecha de venta.
 */
async function openSalesOf(db, customerId, branchWhereClause = {}) {
  const sales = await db.sale.findMany({
    where: {
      customer_contact_id: customerId,
      payment_status: { in: ['PENDING', 'PARTIAL'] },
      payment_method: { is_credit: true },
      status: { name: 'Completada' },
      ...branchWhereClause,
    },
    select: {
      id: true, reference: true, date: true, due_date: true,
      adjusted_total: true, payment_status: true,
      paymentEntries: { select: { amount: true } },
    },
    orderBy: [{ due_date: 'asc' }, { date: 'asc' }],
  })
  return sales
    .map((s) => ({ ...s, balance: balanceOf(s) }))
    .filter((s) => s.balance > ROUND_EPS)
}

/** Recalcula `payment_status` de una venta desde sus abonos. */
async function syncSaleStatus(tx, saleId) {
  const sale = await tx.sale.findUnique({
    where: { id: saleId },
    select: { id: true, adjusted_total: true, paymentEntries: { select: { amount: true } } },
  })
  if (!sale) return
  const status = statusFor(Number(sale.adjusted_total), paidOf(sale))
  await tx.sale.update({ where: { id: saleId }, data: { payment_status: status } })
}

/** Saldo total y vencido de un cliente. */
async function customerBalance(db, customerId, branchWhereClause = {}, now = new Date()) {
  const open = await openSalesOf(db, customerId, branchWhereClause)
  const saldo = round2(open.reduce((s, v) => s + v.balance, 0))
  const vencidas = open.filter((s) => s.due_date && new Date(s.due_date) < now)
  return {
    saldo,
    vencido: round2(vencidas.reduce((s, v) => s + v.balance, 0)),
    facturas_abiertas: open.length,
    facturas_vencidas: vencidas.length,
  }
}

/**
 * Verifica si un cliente puede llevarse `amount` al crédito.
 *
 * Bloquea por límite excedido o por tener facturas vencidas. Devuelve siempre
 * el detalle para que la UI pueda explicarlo y ofrecer la autorización a quien
 * tenga `sales.credit.override`.
 */
async function checkCredit(db, customer, amount, branchWhereClause = {}, now = new Date()) {
  const { saldo, vencido, facturas_vencidas } = await customerBalance(db, customer.id, branchWhereClause, now)
  const nuevo = round2(saldo + round2(amount))
  const limite = customer.credit_limit == null ? null : round2(Number(customer.credit_limit))

  const razones = []
  if (facturas_vencidas > 0) {
    razones.push(`tiene ${facturas_vencidas} factura(s) vencida(s) por ${vencido.toFixed(2)}`)
  }
  if (limite != null && nuevo > limite + ROUND_EPS) {
    razones.push(`excede su límite de ${limite.toFixed(2)} por ${round2(nuevo - limite).toFixed(2)}`)
  }

  return {
    ok: razones.length === 0,
    saldo_actual: saldo,
    saldo_resultante: nuevo,
    limite,
    vencido,
    facturas_vencidas,
    motivo: razones.length ? `El cliente ${razones.join(' y ')}` : null,
  }
}

/**
 * Crea un cobro y lo aplica FIFO, dentro de la transacción que se le pase.
 *
 * Vive acá y no en el controller para que se pueda probar contra una base real
 * sin levantar Express: es la secuencia que mueve dinero.
 */
async function applyPayment(tx, params) {
  const { customerId, branchId, amount, paidAt, paymentMethodId, cashRegisterSessionId, reference, notes, userId } = params

  await lockCustomer(tx, customerId)

  // Las ventas se releen dentro de la transacción (y después del lock): el saldo
  // pudo cambiar entre el momento en que la UI lo mostró y este cobro.
  const open = await openSalesOf(tx, customerId, { branch_id: branchId })
  const applications = planFifo(open, amount)

  const payment = await tx.customerPayment.create({
    data: {
      branch_id: branchId,
      customer_id: customerId,
      amount: round2(amount),
      paid_at: paidAt || new Date(),
      payment_method_id: paymentMethodId,
      cash_register_session_id: cashRegisterSessionId || null,
      reference: reference || null,
      notes: notes || null,
      registered_by: userId,
      applications: { create: applications.map((a) => ({ sale_id: a.sale_id, amount: a.amount })) },
    },
    select: { id: true },
  })

  for (const a of applications) await syncSaleStatus(tx, a.sale_id)
  return { paymentId: payment.id, applications }
}

/** Rangos de antigüedad de un saldo, en días vencidos. */
function agingBucket(dueDate, now = new Date()) {
  if (!dueDate) return 'corriente'
  const dias = Math.floor((now - new Date(dueDate)) / 86400000)
  if (dias <= 0) return 'corriente'
  if (dias <= 30) return 'd1_30'
  if (dias <= 60) return 'd31_60'
  if (dias <= 90) return 'd61_90'
  return 'd90_mas'
}

module.exports = {
  ROUND_EPS,
  ReceivableError,
  statusFor,
  paidOf,
  balanceOf,
  planFifo,
  openSalesOf,
  syncSaleStatus,
  customerBalance,
  checkCredit,
  applyPayment,
  lockCustomer,
  agingBucket,
}
