const { Prisma } = require('@prisma/client')

function allocateNetLineTotals(lines, saleTotal) {
  const total = new Prisma.Decimal(saleTotal)
  if (!total.isFinite() || total.lt(0) || total.gt('9999999999.99')) throw Object.assign(new Error('Total monetario fuera de rango'), { status: 400 })
  const weights = lines.map(line => new Prisma.Decimal(line.price).times(line.qty))
  if (weights.some(value => !value.isFinite() || value.lt(0))) throw Object.assign(new Error('Importe de línea inválido'), { status: 400 })
  const gross = weights.reduce((sum, value) => sum.plus(value), new Prisma.Decimal(0))
  if (gross.eq(0)) return lines.map(() => 0)
  const netCents = total.times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
  let cumulativeGross = new Prisma.Decimal(0)
  let allocatedCents = new Prisma.Decimal(0)
  return lines.map((line, index) => {
    cumulativeGross = cumulativeGross.plus(weights[index])
    const cumulativeCents = index === lines.length - 1
      ? netCents
      : cumulativeGross.div(gross).times(netCents).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    const cents = cumulativeCents.minus(allocatedCents)
    allocatedCents = cumulativeCents
    return cents.div(100).toNumber()
  })
}

module.exports = { allocateNetLineTotals }
