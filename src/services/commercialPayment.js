const { DateTime } = require('luxon')
const { getTimezone } = require('../utils/getTimezone')
const { applyPayment } = require('../modules/receivables')

function fail(message) { throw Object.assign(new Error(message), { status: 400 }) }

async function documentPaymentTerms(tx, body, customerId, companyId, existing = {}) {
  const condition = body.payment_condition ?? existing.payment_condition ?? 'CASH'
  if (!['CASH', 'CREDIT'].includes(condition)) fail('Condición de pago inválida')
  if (condition === 'CASH') return { payment_condition: condition, credit_days: null }
  if (!customerId) fail('Selecciona un cliente registrado para acordar una venta a crédito')
  const customer = await tx.supplier.findFirst({ where: { id: customerId, company_id: companyId }, select: { id: true } })
  if (!customer) fail('Cliente no encontrado en la empresa activa')
  const raw = body.credit_days ?? existing.credit_days
  const days = Number(raw)
  if (!['string', 'number'].includes(typeof raw) || raw === '' || !Number.isSafeInteger(days) || days < 0 || days > 3650) fail('Indica un plazo de crédito válido (0 a 3650 días)')
  return { payment_condition: condition, credit_days: days }
}

function creditDueDate(raw, days, issuedAt, timezone) {
  const issued = DateTime.fromJSDate(issuedAt, { zone: timezone })
  let due
  if (raw != null && raw !== '') {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) fail('La fecha de vencimiento debe tener formato AAAA-MM-DD')
    due = DateTime.fromISO(raw, { zone: timezone })
  } else if (days != null && Number.isSafeInteger(Number(days)) && Number(days) >= 0 && Number(days) <= 3650) {
    due = issued.plus({ days: Number(days) })
  }
  if (!due?.isValid) fail('Indica el vencimiento o configura el plazo de crédito del cliente')
  if (due.startOf('day') < issued.startOf('day')) fail('El vencimiento no puede ser anterior a la fecha de venta')
  return due.endOf('day').toJSDate()
}

function initialPaymentAmount(body, total, isCredit) {
  const raw = body.initial_payment?.amount
  if (raw == null) return 0
  const amount = Number(raw)
  if (!isCredit || !['string', 'number'].includes(typeof raw) || !Number.isFinite(amount) || amount <= 0 || amount >= total || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) fail('El abono inicial debe ser mayor que cero y menor al total, con hasta dos decimales')
  return amount
}

async function recordInitialPayment(tx, req, sale, amount, sessionId) {
  if (!amount) return
  if (!sessionId) fail('Abre un turno de caja antes de recibir el abono inicial')
  const method = await tx.paymentMethod.findUnique({ where: { id: Number(req.body.initial_payment.payment_method_id) || 0 } })
  if (!method || method.is_credit) fail('Selecciona un medio de cobro válido para el abono inicial')
  await applyPayment(tx, {
    customerId: sale.customer_contact_id, branchId: sale.branch_id, amount,
    paidAt: sale.date, paymentMethodId: method.id, cashRegisterSessionId: sessionId,
    reference: sale.reference, notes: 'Abono inicial al registrar la venta', userId: req.user.sub,
    manualApplications: [{ sale_id: sale.id, amount }],
  })
  sale.payment_status = 'PARTIAL'
}

module.exports = { documentPaymentTerms, creditDueDate, initialPaymentAmount, recordInitialPayment, getTimezone }
