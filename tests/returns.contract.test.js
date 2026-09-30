const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ACTIVE_RETURN_STATUSES,
  availableReturnQty,
  assertReturnTransition,
  buildReturnWhere,
  estimateRefundAmount,
  normalizeReturnLines,
} = require('../src/modules/returns/domain')

test('solo solicitudes activas reservan unidades de la venta original', () => {
  assert.deepEqual(ACTIVE_RETURN_STATUSES, ['Pendiente', 'Aprobada', 'Completada'])
  assert.equal(availableReturnQty(10, [
    { qty_returned: 2, status: 'Pendiente' },
    { qty_returned: 3, status: 'Aprobada' },
    { qty_returned: 1, status: 'Completada' },
    { qty_returned: 4, status: 'Rechazada' },
  ]), 4)
})

test('la aprobación no procesa y solo Aprobada puede completarse', () => {
  assert.deepEqual(assertReturnTransition('Pendiente', 'Aprobada'), { terminal: false, processes: false })
  assert.deepEqual(assertReturnTransition('Aprobada', 'Rechazada'), { terminal: true, processes: false })
  assert.deepEqual(assertReturnTransition('Aprobada', 'Completada'), { terminal: true, processes: true })
  assert.throws(() => assertReturnTransition('Pendiente', 'Completada'), /aprobar/i)
  assert.throws(() => assertReturnTransition('Completada', 'Completada'), /terminal/i)
})

test('rechaza líneas repetidas o cantidades no enteras antes de reservar', () => {
  assert.deepEqual(normalizeReturnLines([
    { sale_item_id: 1, product_id: 'product-1', qty_returned: '2' },
  ]), [
    { sale_item_id: 1, product_id: 'product-1', qty_returned: 2, reason: null },
  ])

  assert.throws(() => normalizeReturnLines([
    { sale_item_id: 1, product_id: 'product-1', qty_returned: 1 },
    { sale_item_id: 1, product_id: 'product-1', qty_returned: 1 },
  ]), /repetida/i)
  assert.throws(() => normalizeReturnLines([
    { sale_item_id: 1, product_id: 'product-1', qty_returned: 1.5 },
  ]), /entera/i)
})

test('aplica filtros de devoluciones antes de paginar', () => {
  assert.deepEqual(buildReturnWhere({ branch_id: 'branch-1' }, {
    search: ' ana ',
    status: 'Aprobada',
    type: 'REFUND',
    reason: 'daño',
    date_from: '2026-09-01',
    date_to: '2026-09-30',
  }), {
    sale: { branch_id: 'branch-1' },
    status: { name: 'Aprobada' },
    type: 'REFUND',
    reason: { contains: 'daño', mode: 'insensitive' },
    return_date: {
      gte: new Date('2026-09-01T00:00:00.000Z'),
      lt: new Date('2026-10-01T00:00:00.000Z'),
    },
    OR: [
      { sale: { reference: { contains: 'ana', mode: 'insensitive' } } },
      { sale: { customer: { contains: 'ana', mode: 'insensitive' } } },
      { sale: { customerContact: { is: { name: { contains: 'ana', mode: 'insensitive' } } } } },
      { return_items: { some: { product: { name: { contains: 'ana', mode: 'insensitive' } } } } },
      { replacement_items: { some: { product: { name: { contains: 'ana', mode: 'insensitive' } } } } },
    ],
  })
})

test('estima el reembolso sobre el neto real de una venta con descuento', () => {
  assert.equal(estimateRefundAmount({ saleTotal: 90, grossTotal: 100, unitPrice: 10, qty: 2 }), 18)
  assert.equal(estimateRefundAmount({ saleTotal: 100, grossTotal: 0, unitPrice: 10, qty: 1 }), 0)
})
