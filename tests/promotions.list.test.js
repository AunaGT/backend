const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildPromotionListWhere } = require('../src/modules/promotions/listFilters')
const { attachPromotionUsage } = require('../src/modules/promotions/listFilters')

test('search and status filter the full promotion set before pagination', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  assert.deepEqual(buildPromotionListWhere({ search: ' verano ', status: 'scheduled' }, 'company-1', {}, now), {
    deleted: false,
    company_id: 'company-1',
    AND: [
      { OR: [
        { name: { contains: 'verano', mode: 'insensitive' } },
        { description: { contains: 'verano', mode: 'insensitive' } },
        { codes: { some: { code: { contains: 'verano', mode: 'insensitive' } } } },
      ] },
      { active: true, start_date: { gt: now } },
    ],
  })
})

test('ended excludes disabled promotions and includes dates up to now', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  assert.deepEqual(buildPromotionListWhere({ status: 'ended' }, 'company-1', { OR: [{ applies_to_all_branches: true }] }, now), {
    deleted: false,
    company_id: 'company-1',
    OR: [{ applies_to_all_branches: true }],
    AND: [{ active: true, end_date: { lte: now } }],
  })
})

test('extra filters combine with the tenant scope instead of replacing it', () => {
  const scope = { OR: [{ applies_to_all_branches: true }, { branches: { some: { branch_id: 'branch-1' } } }] }
  assert.deepEqual(buildPromotionListWhere({ scope: 'specific', date_from: '2026-09-01', date_to: '2026-09-30' }, 'company-1', scope).AND, [
    { applies_to_all_branches: false },
    { start_date: { gte: new Date('2026-09-01T06:00:00.000Z'), lt: new Date('2026-10-01T06:00:00.000Z') } },
  ])
  assert.deepEqual(buildPromotionListWhere({ scope: 'specific' }, 'company-1', scope).OR, scope.OR)
})

test('usage totals are based on active codes without loading them all in each row', () => {
  assert.deepEqual(attachPromotionUsage([{ id: 'p1', max_uses: 5 }, { id: 'p2', max_uses: null }], [
    { promotion_id: 'p1', _sum: { current_uses: 3 }, _count: { id: 2 } },
  ]), [
    { id: 'p1', max_uses: 5, usage: { used: 3, capacity: 10 } },
    { id: 'p2', max_uses: null, usage: { used: 0, capacity: null } },
  ])
})
