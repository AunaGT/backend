const CASH_DIFFERENCE_EPSILON = 0.005

function normalizeClosureNotes(notes) {
  return typeof notes === 'string' ? notes.trim() : ''
}

function requiresDifferenceReason(difference, notes) {
  return Math.abs(Number(difference) || 0) >= CASH_DIFFERENCE_EPSILON && !normalizeClosureNotes(notes)
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function applyReturnSettlements(paymentMethodsMap, settlements) {
  let refunds = 0
  let collections = 0
  for (const settlement of settlements || []) {
    if (!['REFUND', 'COLLECTION'].includes(settlement.kind)) continue
    const amount = money(settlement.amount)
    if (amount <= 0) continue
    const sign = settlement.kind === 'REFUND' ? -1 : 1
    if (settlement.kind === 'REFUND') refunds = money(refunds + amount)
    else collections = money(collections + amount)

    const methodId = settlement.payment_method_id
    if (methodId == null) continue
    if (!paymentMethodsMap.has(methodId)) {
      paymentMethodsMap.set(methodId, {
        id: methodId,
        name: settlement.payment_method?.name || 'Método no identificado',
        theoretical_amount: 0,
        theoretical_count: 0,
        sales: [],
      })
    }
    const method = paymentMethodsMap.get(methodId)
    method.theoretical_amount = money(method.theoretical_amount + sign * amount)
    method.theoretical_count += 1
  }
  return { refunds, collections }
}

module.exports = {
  CASH_DIFFERENCE_EPSILON,
  applyReturnSettlements,
  normalizeClosureNotes,
  requiresDifferenceReason,
}
