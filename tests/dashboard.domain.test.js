const test = require('node:test')
const assert = require('node:assert/strict')
const { DateTime } = require('luxon')
const {
  buildPeriodRanges,
  buildPeriodSummary,
  comparisonChange,
  summarizeSales,
} = require('../src/modules/dashboard/domain')

test('los rangos anteriores conservan el mismo tiempo transcurrido', () => {
  const now = DateTime.fromISO('2026-09-19T10:30:00', { zone: 'America/Guatemala' })
  const ranges = buildPeriodRanges(now)
  assert.equal(ranges.today.current.start.toISOString(), '2026-09-19T06:00:00.000Z')
  assert.equal(ranges.today.previous.start.toISOString(), '2026-09-18T06:00:00.000Z')
  assert.equal(ranges.today.previous.end.toISOString(), '2026-09-18T16:30:00.000Z')
})

test('resume ventas netas, costo histórico y ticket promedio', () => {
  const sales = [
    {
      sold_at: new Date('2026-09-19T14:00:00.000Z'),
      adjusted_total: 100,
      sale_items: [{ qty: 2, unit_cost: 20, product: { cost: 99 } }],
    },
    {
      sold_at: new Date('2026-09-19T15:00:00.000Z'),
      adjusted_total: 50,
      sale_items: [{ qty: 1, unit_cost: null, product: { cost: 30 } }],
    },
  ]
  const result = summarizeSales(sales, {
    start: new Date('2026-09-19T06:00:00.000Z'),
    end: new Date('2026-09-20T06:00:00.000Z'),
  })
  assert.deepEqual(result, {
    sales: 150,
    estimatedGrossProfit: 80,
    transactions: 2,
    averageTicket: 75,
  })
})

test('la comparación no inventa porcentajes cuando no hay base anterior', () => {
  assert.equal(comparisonChange(20, 0), null)
  assert.equal(comparisonChange(120, 100), 20)
})

test('cada período incluye su comparación de ventas y utilidad', () => {
  const now = DateTime.fromISO('2026-09-19T10:30:00', { zone: 'America/Guatemala' })
  const ranges = buildPeriodRanges(now)
  const sales = [
    { sold_at: new Date('2026-09-19T14:00:00Z'), adjusted_total: 120, sale_items: [] },
    { sold_at: new Date('2026-09-18T14:00:00Z'), adjusted_total: 100, sale_items: [] },
  ]
  const summary = buildPeriodSummary(sales, ranges)
  assert.equal(summary.today.sales, 120)
  assert.equal(summary.today.salesChange, 20)
  assert.equal(summary.today.previousSales, 100)
})
