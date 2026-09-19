const { DateTime } = require('luxon')

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function round2(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100
}

function comparisonChange(current, previous) {
  const currentValue = number(current)
  const previousValue = number(previous)
  if (Math.abs(previousValue) < 0.005) return null
  return round2(((currentValue - previousValue) / Math.abs(previousValue)) * 100)
}

/**
 * Rangos comparables hasta la misma hora/día del período anterior. De esta
 * forma el lunes a las 10:00 no se compara contra una semana anterior entera.
 */
function buildPeriodRanges(nowInput, timezone = 'America/Guatemala') {
  const now = DateTime.isDateTime(nowInput)
    ? nowInput.setZone(timezone)
    : DateTime.fromJSDate(nowInput instanceof Date ? nowInput : new Date(nowInput), { zone: timezone })

  const comparable = (start, previousStart, previousLimit) => {
    const elapsed = Math.max(0, now.toMillis() - start.toMillis())
    const previousEnd = Math.min(previousStart.toMillis() + elapsed, previousLimit.toMillis())
    return {
      current: { start: start.toUTC().toJSDate(), end: now.toUTC().toJSDate() },
      previous: {
        start: previousStart.toUTC().toJSDate(),
        end: DateTime.fromMillis(previousEnd, { zone: timezone }).toUTC().toJSDate(),
      },
    }
  }

  const dayStart = now.startOf('day')
  const weekStart = now.startOf('week')
  const monthStart = now.startOf('month')
  const previousDayStart = dayStart.minus({ days: 1 })
  const previousWeekStart = weekStart.minus({ weeks: 1 })
  const previousMonthStart = monthStart.minus({ months: 1 })

  return {
    today: comparable(dayStart, previousDayStart, dayStart),
    week: comparable(weekStart, previousWeekStart, weekStart),
    month: comparable(monthStart, previousMonthStart, monthStart),
  }
}

function saleCost(sale) {
  return (sale.sale_items || []).reduce((sum, item) => {
    const unitCost = item.unit_cost == null ? item.product?.cost : item.unit_cost
    return sum + number(unitCost) * number(item.qty)
  }, 0)
}

function summarizeSales(sales, range) {
  const start = range.start.getTime()
  const end = range.end.getTime()
  const inRange = sales.filter((sale) => {
    const timestamp = new Date(sale.sold_at).getTime()
    return timestamp >= start && timestamp < end
  })
  const revenue = inRange.reduce((sum, sale) => sum + number(sale.adjusted_total), 0)
  const cost = inRange.reduce((sum, sale) => sum + saleCost(sale), 0)
  const transactions = inRange.length

  return {
    sales: round2(revenue),
    estimatedGrossProfit: round2(revenue - cost),
    transactions,
    averageTicket: transactions ? round2(revenue / transactions) : 0,
  }
}

function buildPeriodSummary(sales, ranges) {
  return Object.fromEntries(Object.entries(ranges).map(([key, range]) => {
    const current = summarizeSales(sales, range.current)
    const previous = summarizeSales(sales, range.previous)
    return [key, {
      ...current,
      salesChange: comparisonChange(current.sales, previous.sales),
      profitChange: comparisonChange(current.estimatedGrossProfit, previous.estimatedGrossProfit),
      previousSales: previous.sales,
    }]
  }))
}

module.exports = {
  buildPeriodRanges,
  buildPeriodSummary,
  comparisonChange,
  round2,
  saleCost,
  summarizeSales,
}
