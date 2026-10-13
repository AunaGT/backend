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

test('normaliza datos administrativos del despacho y notas', () => {
  const { normalizeOrderAdminDetails } = require('../src/modules/orders/domain')

  assert.deepEqual(normalizeOrderAdminDetails({
    delivery_carrier: '  Auna Logistics  ',
    delivery_tracking_number: '  AUNA-123  ',
    delivery_address: '  Zona 10  ',
    delivery_dispatched_at: '2026-09-23T14:00:00.000Z',
    delivery_estimated_at: '2026-09-24T18:00:00.000Z',
    notes: '  Llamar antes de entregar  ',
  }), {
    delivery_carrier: 'Auna Logistics',
    delivery_tracking_number: 'AUNA-123',
    delivery_address: 'Zona 10',
    delivery_dispatched_at: new Date('2026-09-23T14:00:00.000Z'),
    delivery_estimated_at: new Date('2026-09-24T18:00:00.000Z'),
    notes: 'Llamar antes de entregar',
  })
  assert.throws(() => normalizeOrderAdminDetails({ delivery_dispatched_at: 'ayer' }), /fecha/i)
  assert.throws(() => normalizeOrderAdminDetails({ delivery_dispatched_at: true }), /fecha/i)
  assert.throws(() => normalizeOrderAdminDetails({ delivery_carrier: 'x'.repeat(151) }), /transportista/i)
})
