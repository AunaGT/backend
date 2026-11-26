const { Prisma } = require('@prisma/client')
const { createHash } = require('node:crypto')

function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }) }
function money(value) {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) {
    fail('DISPUTE_MONEY_INVALID', 'Indica un importe válido con hasta dos decimales')
  }
  return new Prisma.Decimal(value)
}
const zero = () => new Prisma.Decimal(0)
const conflict = () => fail('DISPUTE_COVERAGE_CONFLICT', 'El cobro tiene importes incompatibles. Revisa su procedencia antes de continuar.', 409)

function calculateOriginCoverage({ amount, refunded, fundedRefunds = '0', cases }) {
  const original = money(amount), returned = money(refunded), funded = money(fundedRefunds)
  let reserved = zero(), withdrawn = zero(), recovered = zero(), used = zero()
  if (!Array.isArray(cases) || returned.gt(original) || funded.gt(returned)) conflict()
  for (const item of cases) {
    const claim = money(item.claimed), debit = money(item.withdrawn), recovery = money(item.recovered)
    const exposure = debit.sub(recovery)
    if (typeof item.pending !== 'boolean' || claim.lte(0) || exposure.lt(0) || exposure.gt(claim)) conflict()
    withdrawn = withdrawn.add(debit)
    recovered = recovered.add(recovery)
    if (item.pending) reserved = reserved.add(claim)
    // Perdido y todavía no debitado: sigue ocupando principal hasta que el banco lo retire o se recupere.
    const lostPending = item.lost == null ? zero() : Prisma.Decimal.max(0, money(item.lost).sub(Prisma.Decimal.max(0, recovery.sub(money(item.won ?? '0')))))
    used = used.add(item.pending ? claim : Prisma.Decimal.max(exposure, lostPending))
  }
  const claimable = original.sub(returned.sub(funded)).sub(used)
  if (claimable.lt(0)) conflict()
  return Object.fromEntries(Object.entries({ claimable, reserved, withdrawn, recovered }).map(([k,v]) => [k,v.toFixed(2)]))
}

function planDisposition(input) {
  const lost = money(input.lost), withdrawn = money(input.withdrawn), recovered = money(input.recovered)
  const disposed = money(input.disposed), free = money(input.free)
  const customer = money(input.customerPrincipal), absorbed = money(input.absorbedPrincipal)
  const total = customer.add(absorbed)
  const available = Prisma.Decimal.min(lost, withdrawn.sub(recovered)).sub(disposed)
  if (total.lte(0) || available.lt(0) || total.gt(available)) {
    fail('DISPUTE_DISPOSITION_EXCEEDS', 'La resolución supera la pérdida retirada y todavía pendiente de resolver', 409)
  }
  if (customer.gt(0) && input.identifiedCustomer !== true) {
    fail('DISPUTE_CUSTOMER_REQUIRED', 'El cobro debe tener un cliente identificado para recuperar esta pérdida', 409)
  }
  const retired = Prisma.Decimal.min(customer, free)
  return { retired:retired.toFixed(2), charged:customer.sub(retired).toFixed(2), absorbed:absorbed.toFixed(2), total:total.toFixed(2) }
}

function recoveryRows(lots) {
  if (!Array.isArray(lots)) fail('DISPUTE_RECOVERY_INVALID', 'Los destinos de la recuperación no son válidos')
  const seen = new Set()
  return lots.map(lot => {
    if (typeof lot.id !== 'string' || !lot.id || seen.has(lot.id) || !['CUSTOMER_CHARGE','RECEIPT_RETIRED','ABSORBED'].includes(lot.kind)) {
      fail('DISPUTE_RECOVERY_INVALID', 'Los destinos de la recuperación no son válidos')
    }
    seen.add(lot.id)
    return { ...lot, cents:BigInt(money(lot.remaining).mul(100).toFixed(0)) }
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
function planRecovery(lots, rawAmount) {
  const amount = money(rawAmount), rows = recoveryRows(lots)
  if (amount.lte(0)) fail('DISPUTE_RECOVERY_INVALID', 'Indica el principal efectivamente recuperado')
  let left = BigInt(amount.mul(100).toFixed(0))
  if (left > rows.reduce((s,r) => s+r.cents, 0n)) fail('DISPUTE_RECOVERY_EXCEEDS', 'La recuperación supera el principal retirado pendiente', 409)
  const result = []
  for (const customer of [true,false]) {
    const group = rows.filter(r => (r.kind !== 'ABSORBED') === customer && r.cents > 0n)
    const total = group.reduce((s,r) => s+r.cents, 0n)
    if (!total || !left) continue
    const take = left < total ? left : total
    const parts = group.map(r => ({ lotId:r.id, cents:take*r.cents/total }))
    let remainder = take-parts.reduce((s,r) => s+r.cents, 0n)
    for (const part of parts) { if (!remainder) break; part.cents++; remainder-- }
    for (const part of parts) if (part.cents) result.push({ lotId:part.lotId, amount:new Prisma.Decimal(part.cents.toString()).div(100).toFixed(2) })
    left -= take
  }
  return result
}

function planBankRecovery({ withdrawn, recovered, lots, principal }) {
  const exposure = money(withdrawn).sub(money(recovered)), amount = money(principal)
  // Validate lot identities and balances even when this recovery has no disposed destination.
  const disposed = recoveryRows(lots).reduce((sum, lot) => sum.add(lot.cents.toString()), zero()).div(100)
  if (exposure.lt(0) || disposed.gt(exposure)) conflict()
  if (amount.lte(0)) fail('DISPUTE_RECOVERY_INVALID', 'Indica el principal efectivamente recuperado')
  if (amount.gt(exposure)) fail('DISPUTE_RECOVERY_EXCEEDS', 'La recuperación supera el principal retirado pendiente', 409)
  const undisposed = Prisma.Decimal.min(amount, exposure.sub(disposed))
  const remainder = amount.sub(undisposed)
  return { undisposed: undisposed.toFixed(2), lots: remainder.gt(0) ? planRecovery(lots, remainder.toFixed(2)) : [] }
}

function referenceKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) fail('DISPUTE_REFERENCE_INVALID', 'Indica la referencia del proveedor en hasta 120 caracteres')
  return value.trim().normalize('NFC').toUpperCase()
}
function canonicalHash(value) {
  const canonical = item => {
    if (item === null || ['string','boolean'].includes(typeof item)) return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object' && [Object.prototype,null].includes(Object.getPrototypeOf(item))) {
      return Object.fromEntries(Object.keys(item).sort().map(k => [k,canonical(item[k])]))
    }
    fail('DISPUTE_INPUT_INVALID', 'La solicitud contiene datos no válidos')
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
module.exports = { money, fail, calculateOriginCoverage, planDisposition, planRecovery, planBankRecovery, referenceKey, canonicalHash }
