const { Prisma } = require('@prisma/client')

// Local precision preserves 18 fractional multiplication digits without changing legacy math.
const Decimal = Prisma.Decimal.clone({ precision: 64 })
const MAX_QUANTITY = '99999999.999999'
const MAX_MONEY = '9999999999.99'

function fail(message, extra = {}) {
  throw Object.assign(new Error(message), { status: 400, ...extra })
}

function parseDecimal(raw, { decimals = 6, signed = false, allowZero = false, max = MAX_QUANTITY } = {}) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) fail('Precisión de cantidad inválida')
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) fail('Envía la cantidad decimal como cadena')
  if (typeof raw !== 'string' && typeof raw !== 'number' && !Prisma.Decimal.isDecimal(raw)) fail('Cantidad inválida')
  const text = (Prisma.Decimal.isDecimal(raw) ? raw.toFixed() : String(raw)).trim()
  if (text.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(text)) fail('Cantidad inválida')
  const quantity = new Decimal(text)
  if (!quantity.isFinite() || (!signed && quantity.lt(0)) || (!allowZero && quantity.isZero()) || quantity.abs().gt(max)) fail('Cantidad fuera de rango')
  if (quantity.decimalPlaces() > decimals) fail('Cantidad excede los decimales permitidos')
  return quantity
}

function parseQuantity(raw, options = {}) {
  const decimals = options.decimals ?? 6
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) fail('Precisión de cantidad inválida')
  return parseDecimal(raw, options)
}

function convertQuantity(raw, factor, { baseDecimals = 0, allowRounding = false, commercialDecimals = 6 } = {}) {
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 6) fail('Precisión base inválida')
  const quantity = parseQuantity(raw, { decimals: commercialDecimals })
  const multiplier = parseQuantity(factor, { decimals: 12, max: '99999999.999999999999' })
  const exact = quantity.mul(multiplier)
  if (exact.gt(MAX_QUANTITY)) fail('Cantidad base fuera de rango')
  const base = exact.toDecimalPlaces(baseDecimals, Decimal.ROUND_HALF_UP)
  const roundingRequired = !base.eq(exact)
  if (baseDecimals === 0 && roundingRequired) fail('La unidad base es indivisible')
  if (base.isZero() || base.gt(MAX_QUANTITY)) fail('Cantidad base fuera de rango')
  const result = {
    baseQty: base.toFixed(), exactBaseQty: exact.toFixed(),
    roundingDelta: base.sub(exact).toFixed(), roundingRequired,
  }
  if (roundingRequired && allowRounding !== true) fail('La conversión requiere aceptar el redondeo', { code: 'QUANTITY_ROUNDING_REQUIRED', details: result })
  return result
}

function lineTotal(qty, unitPrice) {
  const quantity = parseQuantity(qty)
  const price = parseDecimal(unitPrice, { decimals: 18, allowZero: true, max: MAX_MONEY })
  const total = quantity.mul(price)
  if (total.gt(MAX_MONEY)) fail('Total monetario fuera de rango')
  return total.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
}

module.exports = { parseQuantity, convertQuantity, lineTotal }
