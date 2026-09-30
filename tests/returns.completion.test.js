const test = require('node:test')
const assert = require('node:assert/strict')

const {
  approveReturn,
  buildCompletionPlan,
  completeReturn,
  planReceivableReturn,
} = require('../src/modules/returns/application')
const {
  planApplicationRelease,
  releaseSaleOverpayment,
} = require('../src/modules/receivables/domain/receivables')

const approvedReturn = {
  id: 'return-1',
  total_refund: 18,
  status: { name: 'Aprobada' },
  approved_resolution: 'REFUND_CASH',
  return_items: [
    { id: 11, product_id: 'product-1', qty_returned: 2, refund_amount: 18 },
  ],
  sale: {
    id: 'sale-1',
    branch_id: 'branch-1',
    total: 90,
    total_returned: 0,
    adjusted_total: 90,
    customer_contact_id: null,
    payment_method: { id: 1, is_credit: false },
    paymentEntries: [],
  },
}

test('solo una devolución aprobada puede construir su liquidación', () => {
  assert.throws(() => buildCompletionPlan({
    ...approvedReturn,
    status: { name: 'Pendiente' },
  }, {
    idempotency_key: 'finish-1',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  }), /aprobarse/i)
})

test('restaura únicamente lo recibido y exige ubicación para stock físico', () => {
  const plan = buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-1',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  })
  assert.deepEqual(plan.lines, [{
    return_item_id: 11,
    product_id: 'product-1',
    received_qty: 2,
    restock_qty: 2,
    disposition: 'SELLABLE',
    stock_location_id: 'loc-1',
  }])
  assert.throws(() => buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-2',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'QUARANTINE' }],
    settlement: {},
  }), /ubicación/i)
})

test('desecho registra recepción sin inflar inventario', () => {
  const plan = buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-3',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SCRAP' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  })
  assert.equal(plan.lines[0].restock_qty, 0)
  assert.equal(plan.lines[0].stock_location_id, null)
})

test('el neto guardado conserva el descuento y nunca reduce SaleItem.qty', () => {
  const plan = buildCompletionPlan(approvedReturn, {
    idempotency_key: 'finish-discount',
    lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SCRAP' }],
    settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
  })
  assert.deepEqual(plan.saleAdjustment, {
    total_returned: 18,
    adjusted_total: 72,
  })
  assert.equal(Object.hasOwn(plan.saleAdjustment, 'sale_items'), false)
})

test('en crédito primero baja la deuda y solo libera abonos que exceden el nuevo total', () => {
  assert.deepEqual(planReceivableReturn({ adjustedTotal: 100, paid: 0, refundAmount: 30 }), {
    newAdjustedTotal: 70,
    creditOffset: 30,
    refundable: 0,
    releaseApplications: 0,
  })
  assert.deepEqual(planReceivableReturn({ adjustedTotal: 100, paid: 90, refundAmount: 30 }), {
    newAdjustedTotal: 70,
    creditOffset: 10,
    refundable: 20,
    releaseApplications: 20,
  })
})

test('libera primero la aplicación más reciente sin crear pagos positivos', () => {
  assert.deepEqual(planApplicationRelease([
    { id: 'old', amount: 50, created_at: new Date('2026-01-01') },
    { id: 'new', amount: 40, created_at: new Date('2026-02-01') },
  ], 20), [
    { id: 'new', release: 20, remaining: 20 },
  ])
  assert.throws(() => planApplicationRelease([{ id: 'a', amount: 5 }], 6), /excede/i)
})

test('aprobar conserva la solicitud original y no produce efectos físicos o financieros', async () => {
  const changes = []
  const row = {
    ...approvedReturn,
    status: { name: 'Pendiente' },
    requested_resolution: 'REFUND_CASH',
  }
  const tx = {
    $queryRaw: async () => [{ id: row.id }],
    return: {
      findFirst: async () => row,
      update: async ({ data }) => { changes.push(['return', data]); return { ...row, ...data } },
    },
    returnStatus: { findFirst: async () => ({ id: 2, name: 'Aprobada' }) },
    returnItem: { update: async ({ where, data }) => { changes.push(['line', where.id, data]) } },
    stockLocation: {
      findMany: async () => [{ id: 'loc-1', pickable: true, warehouse: { branch_id: 'branch-1', active: true } }],
    },
  }

  await approveReturn(tx, {
    id: row.id,
    scope: { branch_id: 'branch-1' },
    userId: 'user-1',
    resolution: 'REFUND_TRANSFER',
    lines: [{ return_item_id: 11, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
    policy: { enabledResolutions: ['REFUND_TRANSFER'] },
  })

  assert.equal(row.requested_resolution, 'REFUND_CASH')
  assert.equal(changes[0][1].approved_resolution, 'REFUND_TRANSFER')
  assert.deepEqual(changes[1], ['line', 11, { disposition: 'SELLABLE', stock_location_id: 'loc-1' }])
})

test('desasigna el excedente y deja la venta con estado coherente', async () => {
  const entries = [
    { id: 'old', amount: 50, created_at: new Date('2026-01-01') },
    { id: 'new', amount: 40, created_at: new Date('2026-02-01') },
  ]
  let paymentStatus = 'PAID'
  const tx = {
    salePaymentEntry: {
      findMany: async () => entries,
      update: async ({ where, data }) => { entries.find((row) => row.id === where.id).amount = data.amount },
      delete: async ({ where }) => entries.splice(entries.findIndex((row) => row.id === where.id), 1),
    },
    sale: {
      findUnique: async () => ({ adjusted_total: 70, paymentEntries: entries }),
      update: async ({ data }) => { paymentStatus = data.payment_status },
    },
  }
  assert.equal(await releaseSaleOverpayment(tx, 'sale-1', 20), 20)
  assert.deepEqual(entries.map((row) => [row.id, row.amount]), [['old', 50], ['new', 20]])
  assert.equal(paymentStatus, 'PAID')
})

function completionFixture({ failSettlement = false } = {}) {
  const state = {
    stock: 0,
    status: 'Aprobada',
    sale: { ...approvedReturn.sale },
    lines: approvedReturn.return_items.map((line) => ({ ...line })),
    settlements: [],
  }
  const tx = {
    $queryRaw: async () => [{ id: approvedReturn.id }],
    return: {
      findFirst: async () => ({ ...approvedReturn, status: { name: state.status }, sale: state.sale, return_items: state.lines }),
      update: async ({ data }) => {
        if (data.status_id === 4) state.status = 'Completada'
        return { ...approvedReturn, ...data, status: { name: state.status }, sale: state.sale, return_items: state.lines }
      },
    },
    returnStatus: { findFirst: async () => ({ id: 4, name: 'Completada' }) },
    returnItem: {
      update: async ({ where, data }) => Object.assign(state.lines.find((line) => line.id === where.id), data),
    },
    returnSettlement: {
      findFirst: async ({ where }) => state.settlements.find((row) => row.return_id === where.return_id && row.idempotency_key === where.idempotency_key) || null,
      create: async ({ data }) => {
        if (failSettlement) throw new Error('caja no disponible')
        const row = { id: `settlement-${state.settlements.length + 1}`, ...data }
        state.settlements.push(row)
        return row
      },
    },
    stockLocation: { findMany: async () => [{ id: 'loc-1', pickable: true }] },
    cashRegisterSession: { findFirst: async () => ({ id: 'cash-1', status: 'OPEN' }) },
    paymentMethod: { findUnique: async () => ({ id: 1, name: 'Efectivo', is_credit: false }) },
    sale: {
      update: async ({ data }) => Object.assign(state.sale, data),
    },
  }
  const client = {
    $transaction: async (callback) => {
      const snapshot = structuredClone(state)
      try { return await callback(tx) } catch (error) { Object.assign(state, snapshot); throw error }
    },
  }
  const deps = {
    restoreStock: async (_tx, lines) => { state.stock += lines.reduce((sum, line) => sum + line.restock_qty, 0) },
    ensureAlerts: async () => {},
  }
  const params = {
    id: approvedReturn.id,
    scope: { branch_id: 'branch-1' },
    userId: 'user-1',
    payload: {
      idempotency_key: 'finish-once',
      lines: [{ return_item_id: 11, received_qty: 2, disposition: 'SELLABLE', stock_location_id: 'loc-1' }],
      settlement: { payment_method_id: 1, cash_register_session_id: 'cash-1' },
    },
  }
  return { state, client, deps, params }
}

test('Aprobada se completa una sola vez con la misma clave', async () => {
  const fixture = completionFixture()
  const first = await completeReturn(fixture.client, fixture.params, fixture.deps)
  const second = await completeReturn(fixture.client, fixture.params, fixture.deps)
  assert.equal(first.status.name, 'Completada')
  assert.equal(second._idempotent, true)
  assert.equal(fixture.state.stock, 2)
  assert.equal(fixture.state.sale.adjusted_total, 72)
  assert.equal(fixture.state.settlements.length, 1)
})

test('un fallo al registrar la salida de caja revierte inventario y venta', async () => {
  const fixture = completionFixture({ failSettlement: true })
  await assert.rejects(() => completeReturn(fixture.client, fixture.params, fixture.deps), /caja no disponible/)
  assert.equal(fixture.state.stock, 0)
  assert.equal(fixture.state.sale.adjusted_total, 90)
  assert.equal(fixture.state.status, 'Aprobada')
  assert.equal(fixture.state.settlements.length, 0)
})
