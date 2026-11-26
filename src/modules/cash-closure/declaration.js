const { Prisma } = require('@prisma/client')
const { isCashMethod } = require('../../services/paymentMethods/behavior')
const { normalizeClosureNotes } = require('./domain')
const fail = message => { throw Object.assign(new Error(message), { status: 400 }) }
function amount(value, label, signed = false) {
  const pattern = signed ? /^-?(0|[1-9]\d*)(\.\d{1,2})?$/ : /^(0|[1-9]\d*)(\.\d{1,2})?$/
  if (!['string', 'number'].includes(typeof value) || !pattern.test(String(value))) fail(`${label}: ingresa un monto ${signed ? 'válido' : 'no negativo'} con hasta dos decimales`)
  const n = new Prisma.Decimal(String(value))
  if (n.abs().gt('9999999999.99')) fail(`${label}: el monto excede el límite permitido`)
  return n
}
function quantity(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000000) fail(`${label}: ingresa una cantidad entera no negativa`)
  return value
}
function validateDeclaration(body, data, { blind = false } = {}) {
  const declared = amount(body.actualTotal, 'Total contado', data.payment_breakdown.some(method => method.settlement_kind === 'BANK'))
  if (!Array.isArray(body.paymentBreakdowns) || body.paymentBreakdowns.length !== data.payment_breakdown.length) fail('Declara el importe contado de cada medio de pago del cálculo')
  const expected = new Map(data.payment_breakdown.map(m => [m.breakdown_key || m.payment_method_id, m]))
  const seen = new Set()
  let total = new Prisma.Decimal(0), cash = new Prisma.Decimal(0)
  const payments = body.paymentBreakdowns.map(row => {
    const key = row?.breakdown_key || row?.payment_method_id
    const method = expected.get(key)
    if (!method || method.payment_method_id !== row.payment_method_id || seen.has(key)) fail('Medio de pago desconocido o duplicado; recalcula el arqueo')
    seen.add(key)
    const actual = amount(row.actual_amount, 'Importe contado por medio', method.settlement_kind === 'BANK')
    total = total.add(actual)
    if (isCashMethod({ ...method, name: method.payment_method_name }, name => /efectivo|cash/i.test(name))) cash = cash.add(actual)
    if (row.notes != null && (typeof row.notes !== 'string' || row.notes.length > 2000)) fail('La observación del medio admite hasta 2000 caracteres')
    const difference = actual.sub(String(method.theoretical_amount))
    // Con conteo ciego quien declara no ve la diferencia: la explica el revisor al aceptarla.
    if (!blind && !difference.isZero() && !row.notes?.trim()) fail(`Indica el motivo de la diferencia en ${method.payment_method_name || 'cada medio de pago'}`)
    return { ...(method.breakdown_key ? { breakdown_key: method.breakdown_key } : {}), payment_method_id: method.payment_method_id, theoretical_amount: method.theoretical_amount, theoretical_count: method.theoretical_count, actual_amount: actual.toFixed(2), actual_count: row.actual_count == null ? null : quantity(row.actual_count, 'Comprobantes'), difference: difference.toFixed(2), notes: row.notes?.trim() || null }
  })
  if (!declared.eq(total)) fail('El total contado no coincide con la suma de los medios de pago')
  const raw = body.denominations ?? []
  if (!Array.isArray(raw) || raw.length > 100) fail('Desglose de billetes y monedas inválido')
  const denominationKeys = new Set()
  let counted = new Prisma.Decimal(0)
  const denominations = raw.map(row => {
    if (!row || !['Billete', 'Moneda'].includes(row.type)) fail('Tipo de denominación inválido')
    const denomination = amount(row.denomination, 'Denominación'), count = quantity(row.quantity, 'Billetes o monedas')
    const key = `${row.type}:${denomination.toFixed(2)}`
    if (denomination.isZero() || denominationKeys.has(key)) fail('Denominación inválida o duplicada')
    denominationKeys.add(key)
    const subtotal = denomination.mul(count)
    counted = counted.add(subtotal)
    return { denomination: denomination.toFixed(2), type: row.type, quantity: count, subtotal: subtotal.toFixed(2) }
  })
  if (raw.length && !cash.eq(counted)) fail('Los billetes y monedas no coinciden con el efectivo declarado')
  if (body.notes != null && (typeof body.notes !== 'string' || body.notes.length > 10000)) fail('Las observaciones admiten hasta 10000 caracteres')
  const difference = declared.sub(String(data.theoretical.net_total))
  const notes = normalizeClosureNotes(body.notes)
  if (Number(data.unidentified_collections_amount) > 0 && !notes) fail('Explica la diferencia del dinero histórico con medio no registrado')
  return { actualTotal: declared.toFixed(2), difference: difference.toFixed(2), payments, denominations: denominations.filter(d => d.quantity > 0), notes }
}

module.exports = { validateDeclaration }
