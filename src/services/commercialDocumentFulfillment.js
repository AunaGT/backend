/**
 * Utilidades entrega parcial de pedidos.
 */

const {Prisma}=require('@prisma/client')
const {commercialQuantity}=require('./catalogItemRules')
const {isV2,D,partialUnitLine,cumulativeAmount}=require('./units/commercial')
function netDocumentLines(document){
  const lines=document.lines||[]
  if(!lines.some(isV2)||document.total==null)return lines
  const gross=lines.reduce((sum,line)=>sum.add(line.line_total),D(0)),total=D(document.total)
  if(gross.eq(total))return lines
  if(total.lt(0)||total.gt(gross)||gross.lte(0))throw Object.assign(new Error('Las partidas no concilian con el acuerdo comercial'),{status:409})
  let accumulated=D(0),assigned=D(0)
  return lines.map((line,index)=>{
    accumulated=accumulated.add(line.line_total)
    const end=index===lines.length-1?total:total.mul(accumulated).div(gross).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP)
    const net=end.sub(assigned);assigned=end
    return{...line,line_total:net.toDecimalPlaces(2)}
  })
}
function pendingLineQty(line) {
  if(isV2(line))return Prisma.Decimal.max(0,new Prisma.Decimal(String(line.available_base??line.base_qty??0)).sub(String(line.base_fulfilled || 0)))
  return Prisma.Decimal.max(0,new Prisma.Decimal(String(line.qty || 0)).sub(String(line.qty_fulfilled || 0)))
}

function partialLineTotal(line, qty, consumedQty) {
  if(isV2(line))return cumulativeAmount(line.line_total,line.base_qty,qty,consumedQty)
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
      const resolved = isV2(line) ? partialUnitLine(line,item) : null
      const qty = resolved?.qty ?? commercialQuantity(item.qty,line)
      const compared = resolved?.base_qty ?? qty
      const pending = pendingLineQty(line)
      if (!qty.isFinite() || qty.lte(0)) {
        const err = new Error('Cada línea debe tener qty > 0')
        err.status = 400
        throw err
      }
      if (compared.gt(pending)) {
        const err = new Error(`Cantidad (${qty}) supera pendiente (${pending}) en línea ${lineId}`)
        err.status = 400
        throw err
      }
      out.push({ line, qty, ...(resolved || {}), line_id: lineId })
    }
    return out
  }

  return orderLines
    .map((line) => {
      const pending=pendingLineQty(line)
      return {line,qty:pending,line_id:String(line.id),...(isV2(line)&&pending.gt(0)?partialUnitLine(line,{qty:pending.toFixed(),presentation_id:null}):{})}
    })
    .filter((x) => x.qty.gt(0))
}

module.exports = {
  netDocumentLines,
  pendingLineQty,
  isOrderFullyFulfilled,
  resolveFulfillmentLines,
  partialLineTotal,
}
