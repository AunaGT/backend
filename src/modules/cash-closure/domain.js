const CASH_DIFFERENCE_EPSILON = 0.005
const {isCashMethod}=require('../../services/paymentMethods/behavior')
const {listPaymentMethodChoices}=require('../../services/paymentMethods/access')
const legacyCashName=name=>/efectivo|cash/i.test(name)

async function applyOpeningFloatToCashBreakdown(db,companyId,map,openingFloat) {
  const float=money(openingFloat)
  if(float<=0)return {openingFloat:0,cashSalesAmount:0}
  let entry=[...map.values()].find(m=>isCashMethod(m,legacyCashName))
  if(!entry){
    const methods=await listPaymentMethodChoices(db,companyId,{includeInactive:true})
    const method=methods.find(m=>m.origin==='BASIC'&&m.settlement_kind==='CASH')||methods.find(m=>m.settlement_kind==='CASH')||methods.find(m=>isCashMethod(m,legacyCashName))
    if(method){entry={id:method.id,name:method.name,settlement_kind:method.settlement_kind,theoretical_amount:0,theoretical_count:0,sales:[]};map.set(method.id,entry)}
  }
  if(!entry)return {openingFloat:float,cashSalesAmount:0}
  const cashSalesAmount=money(entry.theoretical_amount)
  entry.theoretical_amount=money(cashSalesAmount+float)
  return {openingFloat:float,cashSalesAmount}
}

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
        settlement_kind:settlement.payment_method?.settlement_kind??null,
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
  applyOpeningFloatToCashBreakdown,
  CASH_DIFFERENCE_EPSILON,
  applyReturnSettlements,
  normalizeClosureNotes,
  requiresDifferenceReason,
}
