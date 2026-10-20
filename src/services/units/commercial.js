const { Prisma } = require('@prisma/client')
const { parseQuantity } = require('./quantity')
const ExactDecimal = parseQuantity('0',{allowZero:true}).constructor
const D = value => new ExactDecimal(String(value ?? 0))
const isV2 = line => line.unit_metadata_version === 2 && line.unit_snapshot?.version === 2

function partialUnitLine(line, input, quantityKey = 'qty') {
  if(['base_qty','factor','unit_snapshot','unit_metadata_version','physical_snapshot','frozen_unit_price','authorization','authorization_context'].some(key=>Object.hasOwn(input,key)))throw Object.assign(new Error('El servidor determina la conversión y el snapshot'),{status:400})
  const original = line.unit_snapshot
  if (Object.hasOwn(input, 'presentation_id') && input.presentation_id !== null) {
    throw Object.assign(new Error('La operación parcial solo admite la presentación original o la unidad base'), { status: 400 })
  }
  const base = Object.hasOwn(input, 'presentation_id') && input.presentation_id === null
  const snapshot = structuredClone(original)
  if (base) { snapshot.presentation = null; snapshot.factor = '1'; snapshot.roundingDelta = '0' }
  const precision = snapshot.presentation?.decimals ?? snapshot.baseUnit.decimals
  const qty = parseQuantity(input[quantityKey], { decimals: precision })
  // Accepted base quantity, including an approved original rounding, is authoritative.
  const baseQty = base ? qty : parseQuantity(qty.mul(D(line.base_qty)).div(D(line.qty)), { decimals: original.baseUnit.decimals })
  const price = base ? D(line.unit_price ?? line.price).mul(D(line.qty)).div(D(line.base_qty)).toDecimalPlaces(18) : D(line.unit_price ?? line.price)
  return { qty, base_qty: baseQty, unit_snapshot: snapshot, unit_metadata_version: 2,
    unit_label: snapshot.presentation?.label ?? snapshot.baseUnit.label, quantity_decimals: precision, unit_price: price }
}

function unitFields(line) {
  return isV2(line) ? { unit_metadata_version: 2, unit_snapshot: line.unit_snapshot, base_qty: line.base_qty,
    ...(line.base_unit_cost != null ? { base_unit_cost: line.base_unit_cost } : {}) } : {}
}

function cumulativeAmount(total, originalBase, qty, consumed = 0) {
  const original = D(originalBase), prior = D(consumed), end = prior.add(D(qty))
  if (original.lte(0) || prior.lt(0) || end.gt(original)) throw Object.assign(new Error('Cantidad fuera del saldo original'), { status: 400 })
  const at = amount => D(total).mul(amount).div(original).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  return at(end).sub(at(prior))
}

module.exports = { D, isV2, partialUnitLine, unitFields, cumulativeAmount }
