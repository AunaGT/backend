function allocateNetLineTotals(lines, saleTotal) {
  const gross = lines.reduce((sum, line) => sum + Number(line.price) * Number(line.qty), 0)
  if (!(gross > 0)) return lines.map(() => 0)
  const netCents = Math.round(Number(saleTotal) * 100)
  let cumulativeGross = 0
  let allocatedCents = 0
  return lines.map((line, index) => {
    cumulativeGross += Number(line.price) * Number(line.qty)
    const cumulativeCents = index === lines.length - 1
      ? netCents
      : Math.round((cumulativeGross / gross) * netCents)
    const cents = cumulativeCents - allocatedCents
    allocatedCents = cumulativeCents
    return cents / 100
  })
}

module.exports = { allocateNetLineTotals }
