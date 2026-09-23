const test = require('node:test')
const assert = require('node:assert/strict')

test('combina estados visuales de preparación y entrega', () => {
  const { resolveOrderStatuses } = require('../src/modules/orders/domain')

  assert.deepEqual(resolveOrderStatuses({ preparation: 'ready' }), ['PARTIALLY_FULFILLED', 'FULFILLED'])
  assert.deepEqual(resolveOrderStatuses({ delivery: 'transit' }), ['PARTIALLY_FULFILLED'])
  assert.deepEqual(resolveOrderStatuses({ preparation: 'ready', delivery: 'delivered' }), ['FULFILLED'])
  assert.deepEqual(resolveOrderStatuses({ preparation: 'preparing', delivery: 'delivered' }), [])
})

test('valida fechas y ordenamiento del listado', () => {
  const { buildOrderDateFilter, resolveOrderOrderBy } = require('../src/modules/orders/domain')

  assert.deepEqual(buildOrderDateFilter('2026-09-01', '2026-09-30'), {
    gte: new Date('2026-09-01T00:00:00.000Z'),
    lt: new Date('2026-10-01T00:00:00.000Z'),
  })
  assert.deepEqual(resolveOrderOrderBy('total_desc'), { total: 'desc' })
  assert.throws(() => buildOrderDateFilter('ayer', ''), /fecha/i)
  assert.throws(() => resolveOrderOrderBy('random'), /orden/i)
})
