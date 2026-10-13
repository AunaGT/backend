/**
 * Utilidades entrega parcial de pedidos.
 */

const {Prisma}=require('@prisma/client')
const {commercialQuantity}=require('./catalogItemRules')
function pendingLineQty(line) {
  return Prisma.Decimal.max(0,new Prisma.Decimal(String(line.qty || 0)).sub(String(line.qty_fulfilled || 0)))
}

function partialLineTotal(line, qty, consumedQty) {
  const totalQty = new Prisma.Decimal(String(line.qty))
  const consumed = new Prisma.Decimal(String(consumedQty || 0))
  const end = consumed.add(String(qty))
  if (totalQty.lte(0) || consumed.lt(0) || end.gt(totalQty)) throw Object.assign(new Error('Cantidad facturada fuera de rango'), { status: 400 })
  const total = new Prisma.Decimal(String(line.line_total ?? totalQty.mul(String(line.unit_price)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)))
  // Cumulative rounding gives the last fraction the remaining cents, not an extra cent.
  const amountAt = amount => total.mul(amount).div(totalQty).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  return amountAt(end).sub(amountAt(consumed))
}

function isOrderFullyFulfilled(lines) {
  if (!lines?.length) return false
  return lines.every((l) => pendingLineQty(l).eq(0))
}

/**
 * @param {Array<{ id: string, qty: number, qty_fulfilled?: number, product_id: string }>} orderLines
 * @param {Array<{ line_id: string, qty: number }>|undefined} raw
 */
function resolveFulfillmentLines(orderLines, raw) {
  const lineMap = new Map(orderLines.map((l) => [String(l.id), l]))

  if (Array.isArray(raw) && raw.length > 0) {
    const out = []
    const seen=new Set()
    for (const item of raw) {
      const lineId = String(item.line_id || '')
      if (seen.has(lineId)) throw Object.assign(new Error('Partida duplicada'),{status:400})
      seen.add(lineId)
      const line = lineMap.get(lineId)
      if (!line) {
        const err = new Error(`Línea no encontrada: ${lineId}`)
        err.status = 400
        throw err
      }
      const qty = commercialQuantity(item.qty,line)
      const pending = pendingLineQty(line)
      if (!qty.isFinite() || qty.lte(0)) {
        const err = new Error('Cada línea debe tener qty > 0')
        err.status = 400
        throw err
      }
      if (qty.gt(pending)) {
        const err = new Error(`Cantidad (${qty}) supera pendiente (${pending}) en línea ${lineId}`)
        err.status = 400
        throw err
      }
      out.push({ line, qty, line_id: lineId })
    }
    return out
  }

  return orderLines
    .map((line) => ({ line, qty: pendingLineQty(line), line_id: String(line.id) }))
    .filter((x) => x.qty.gt(0))
}

module.exports = {
  pendingLineQty,
  isOrderFullyFulfilled,
  resolveFulfillmentLines,
  partialLineTotal,
}
