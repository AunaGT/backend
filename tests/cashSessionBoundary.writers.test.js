const test = require('node:test'), assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { commerceHarness } = require('./helpers/unitsCommerceHarness.cjs')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { companyId: id(1), branchId: id(2), userId: id(3), isAdmin: false }
const session = extra => ({ id: id(4), status: 'OPEN', opened_by_id: scope.userId,
  opened_at: new Date('2026-10-28T12:00:00Z'), register_active: true, register_kind: 'PHYSICAL', ...extra })

test('the receipt domain rejects a closed turn before customer locks, allocations or receipt writes', async () => {
  const calls = []
  const tx = {
    $queryRaw: async () => { calls.push('session'); return [session({ status: 'CLOSED' })] },
    $executeRaw: async (_sql, ...values) => { if (values.includes(910005)) calls.push('customer') },
    companyPaymentMethod: { findFirst: async () => ({ enabled: true, payment_method: { id: 1, settlement_kind: 'CASH', is_credit: false } }) },
    sale: { findMany: async () => [] }, customerPayment: { create: async () => { calls.push('receipt'); return { id: 'payment' } } },
  }
  await assert.rejects(require('../src/modules/receivables').applyPayment(tx, {
    ...scope, customerId: id(6), amount: 25, paymentMethodId: 1, cashRegisterSessionId: id(4), allowAdvance: true,
  }), e => e.code === 'CASH_SESSION_CLOSED')
  assert.ok(!calls.includes('customer')); assert.ok(!calls.includes('receipt'))
})
test('new cash receipts cannot silently become unassigned money', async () => {
  const tx = { $executeRaw: async () => {}, companyPaymentMethod: { findFirst: async () => ({ enabled: true, payment_method: { id: 1, settlement_kind: 'CASH', is_credit: false } }) },
    sale: { findMany: async () => [] }, customerPayment: { create: async () => assert.fail('receipt must not be inserted') } }
  await assert.rejects(require('../src/modules/receivables').applyPayment(tx, { ...scope, customerId: id(6), amount: 25, paymentMethodId: 1, allowAdvance: true }), e => e.code === 'CASH_SESSION_REQUIRED')
})
test('the Agenda receipt domain acquires the session before its customer lock', async () => {
  const calls = []
  const tx = { $queryRaw: async () => { calls.push('session'); return [session({ status: 'CLOSED' })] }, $executeRaw: async () => calls.push('customer') }
  await assert.rejects(require('../src/modules/receivables').receiveEngagementPayment(tx, scope,
    { company_id: scope.companyId, branch_id: scope.branchId, customer_id: id(6) }, { cashRegisterSessionId: id(4) }), e => e.code === 'CASH_SESSION_CLOSED')
  assert.deepEqual(calls, ['session'])
})
test('a closed turn is acquired before documents and rejects actual refunds before changing stock', async () => {
  const calls = []
  const row = { id: id(7), return_date: new Date(), status: { name: 'Aprobada' }, approved_resolution: 'REFUND_CASH', total_refund: 25,
    return_items: [{ id: 1, product_id: id(8), sale_item_id: 2, qty_returned: 1 }], sale: { id: id(9), date: new Date(), status: { name: 'Completada' },
      branch_id: scope.branchId, customer_contact_id: id(6), total: 25, adjusted_total: 25, payment_method: { id: 1, is_credit: false }, sale_items: [{ id: 2, item_kind: 'SERVICE' }] } }
  const tx = { return: { findFirst: async () => row },
    returnSettlement: { findFirst: async () => null },
    systemSetting: { findUnique: async () => null },
    companyPaymentMethod: { findFirst: async () => ({ enabled: true, payment_method: { id: 1, settlement_kind: 'CASH', is_credit: false } }) },
    $executeRaw: async () => calls.push('customer'),
    $queryRaw: async sql => { if (String(sql).includes('cash_register_sessions')) { calls.push('session'); return [session({ status: 'CLOSED' })] }
      calls.push('sale'); return [{ id: row.id }] },
  }
  await assert.rejects(require('../src/modules/returns/application').completeApprovedReturn(tx, {
    id: id(7), companyId: scope.companyId, userId: scope.userId, scope: { branch_id: scope.branchId }, permissions: ['returns.complete'],
    payload: { idempotency_key: 'refund-once', lines: [{ return_item_id: 1 }], settlement: { payment_method_id: 1, cash_register_session_id: id(4) } },
  }), e => e.code === 'CASH_SESSION_CLOSED')
  assert.equal(calls[0], 'session'); assert.ok(calls.includes('sale'))
})
test('a refund retry already committed remains observable after its turn closes', async () => {
  const current = { id: id(7), sale: { branch_id: scope.branchId }, status: { name: 'Completada' } }
  const settlement = { id: id(8), return_id: current.id, idempotency_key: 'original' }
  const tx = { return: { findFirst: async () => current }, returnSettlement: { findFirst: async () => settlement },
    $queryRaw: async sql => { assert.ok(!String(sql).includes('cash_register_sessions')); return [{ id: current.id }] } }
  const result = await require('../src/modules/returns/application').completeApprovedReturn(tx, {
    id: current.id, companyId: scope.companyId, userId: scope.userId, scope: { branch_id: scope.branchId }, permissions: ['returns.complete'],
    payload: { idempotency_key: 'original', settlement: { cash_register_session_id: id(4) } },
  })
  assert.equal(result._idempotent, true); assert.equal(result._settlement.id, settlement.id)
})
test('a concurrently changed return resolution is rejected before acquiring a session after its document lock', async () => {
  let reads = 0
  const tx = { return: { findFirst: async () => ({ approved_resolution: ++reads === 1 ? 'CUSTOMER_CREDIT' : 'REFUND_CASH',
    sale: { branch_id: scope.branchId, customer_contact_id: null } }) }, returnSettlement: { findFirst: async () => null },
    systemSetting: { findUnique: async () => assert.fail('changed approval reached settlement policy without a conflict') },
    $queryRaw: async sql => { assert.ok(!String(sql).includes('cash_register_sessions'), 'session must not be acquired after document'); return [{ id: id(7) }] } }
  await assert.rejects(require('../src/modules/returns/application').completeApprovedReturn(tx, {
    id: id(7), companyId: scope.companyId, userId: scope.userId, scope: { branch_id: scope.branchId }, permissions: ['returns.complete'],
    payload: { idempotency_key: 'changed-resolution', settlement: { cash_register_session_id: id(4) } },
  }), e => e.status === 409 && /cambiado/.test(e.message))
})
test('a role merely named Admin cannot check out over a different operator turn', async () => {
  const f = commerceHarness({ products: [{ id: 'P', company_id: 'A', name: 'QA', kind: 'STANDARD', deleted: false, available_for_sale: true, quantity_decimals: 0, unit_metadata_version: 2, base_unit_id: 'UNIT', unit_revision: 1, price: '2', cost: '1' }], stock: { P: '10' }, locations: { 'P|L': '10' }, units: [{ id: 'UNIT', company_id: 'A', code: 'UNIT', name: 'Unidad', label: 'ud' }] })
  f.tx.cashRegisterSession.findFirst = async () => ({ id: id(4), opened_by_id: 'other' })
  const raw = f.tx.$queryRaw
  f.tx.$queryRaw = async (sql, ...values) => String(sql).includes('cash_register_sessions') ? [session({ opened_by_id: 'other' })] : String(sql).includes('pg_advisory_xact_lock') ? [] : raw(sql, ...values)
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: f.tx, prismaTransaction: f.tx }, [require.resolve('../src/services/referenceGenerator')]: { nextDocumentReference: async () => 'V-QA' } }, require.resolve('../src/modules/sales/controller'), async api => {
    const response = jsonResponse(); let error
    await api.create({ companyId: 'A', branchId: 'B', query: { response: 'confirmation' }, user: { sub: 'U', role: { name: 'Admin' }, permissions: ['sales.create'] },
      body: { cash_register_id: 'C', payment_method_id: 1, items: [{ product_id: 'P', qty: 1, presentation_id: null, unit_revision: 1 }] } }, response, e => { error = e })
    assert.equal(error?.status || response.statusCode, 403, error?.message || JSON.stringify(response.body))
    assert.equal(f.state.sales.length, 0); assert.equal(f.state.stock.P, '10')
  })
})
test('canonical admin needs a turn for legacy cash, while BANK remains explicitly unassigned in POS', async () => {
  for (const [name, kind] of [['Cash', null], ['Efectivo USD', null], ['Transferencia', 'BANK']]) {
    const f = commerceHarness({ products: [{ id: 'P', company_id: 'A', name: 'QA', kind: 'STANDARD', deleted: false, available_for_sale: true, quantity_decimals: 0, unit_metadata_version: 2, base_unit_id: 'UNIT', unit_revision: 1, price: '2', cost: '1' }], stock: { P: '10' }, locations: { 'P|L': '10' }, units: [{ id: 'UNIT', company_id: 'A', code: 'UNIT', name: 'Unidad', label: 'ud' }] })
    f.tx.cashRegisterSession.findFirst = async () => null
    f.tx.companyPaymentMethod.findFirst = async () => ({ enabled: true, payment_method: { id: 1, name, is_credit: false, settlement_kind: kind } })
    await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: f.tx, prismaTransaction: f.tx }, [require.resolve('../src/services/referenceGenerator')]: { nextDocumentReference: async () => 'V-QA' } }, require.resolve('../src/modules/sales/controller'), async api => {
      let error; const response = jsonResponse()
      await api.create({ companyId: 'A', branchId: 'B', query: { response: 'confirmation' }, user: { sub: 'U', role: { name: 'admin', company_id: null, system_key: 'ADMIN' } },
        body: { cash_register_id: 'C', payment_method_id: 1, items: [{ product_id: 'P', qty: 1, presentation_id: null, unit_revision: 1 }] } }, response, e => { error = e })
      if (kind === 'BANK') {
        assert.equal(error, undefined); assert.equal(response.statusCode, 201)
        assert.equal(f.state.sales[0].cash_register_session_id ?? null, null); assert.equal(f.state.stock.P, '9')
      } else {
        assert.equal(error?.code || response.body?.code, 'CASH_SESSION_REQUIRED', `${name}: ${error?.message || response.statusCode}`)
        assert.equal(f.state.sales.length, 0); assert.equal(f.state.stock.P, '10')
      }
    })
  }
})
test('legacy order conversion also requires a turn for canonical admin receiving legacy cash', async () => {
  const order = { id: id(20), branch_id: scope.branchId, status: 'CONFIRMED', fulfillment_mode: 'LEGACY', lines: [{ id: 'line', product_id: 'P', qty: 1, qty_fulfilled: 0, unit_price: 2 }] }
  const db = { commercialDocument: { findFirst: async () => order }, cashRegister: { findFirst: async () => ({ id: id(21) }) }, cashRegisterSession: { findFirst: async () => null },
    companyPaymentMethod: { findFirst: async () => ({ enabled: true, payment_method: { id: 1, name: 'Cash', is_credit: false, settlement_kind: null } }) },
    $executeRaw: async () => {}, $queryRaw: async () => assert.fail('must reject missing cash turn before locking the order') }
  db.$transaction = async work => work(db)
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve('../src/modules/orders/controller'), async api => {
    const response = jsonResponse(); let error
    await api.convertToSale({ companyId: scope.companyId, branchId: scope.branchId, params: { id: order.id }, user: { sub: scope.userId, role: { name: 'admin', company_id: null, system_key: 'ADMIN' } },
      body: { payment_method_id: 1, cash_register_id: id(21), lines: [{ line_id: 'line', qty: 1 }] } }, response, e => { error = e })
    assert.equal(error?.status || response.statusCode, 403)
    assert.match(error?.message || response.body?.message || '', /caja/i)
  })
})

test('invoicing an order acquires its cash boundary before locking the commercial document', async () => {
  const calls = [], order = { id: id(10), branch_id: scope.branchId, fulfillment_mode: 'SEPARATE', status: 'FULFILLED', lines: [{ id: 'line', product_id: 'P', qty: 1, qty_fulfilled: 1, qty_invoiced: 0, unit_price: 10 }] }
  const tx = { $queryRaw: async sql => { if (String(sql).includes('cash_register_sessions')) { calls.push('session'); return [session({ status: 'CLOSED' })] }
    if (String(sql).includes('commercial_documents')) calls.push('order'); return [{ id: order.id }] }, $executeRaw: async () => {},
    commercialDocument: { findUnique: async () => order }, appointmentEngagement: { findFirst: async () => null }, sale: { findFirst: async () => null },
    companyPaymentMethod: { findFirst: async () => ({ enabled: true, payment_method: { id: 1, is_credit: false, settlement_kind: 'CASH' } }) } }
  const req = { companyId: scope.companyId, branchId: scope.branchId, params: { id: order.id }, user: { sub: scope.userId }, body: { request_key: id(11), payment_method_id: 1, lines: [{ line_id: 'line', qty: 1 }] } }
  await assert.rejects(require('../src/modules/orders/fulfillment').invoice(tx, req, async () => {
    const boundary = require('../src/services/cashSessionBoundary')
    boundary.assertSessionOperation(await boundary.lockScopedSession(tx, scope, id(4)), scope, { settlementKind: 'CASH' })
  }), e => e.code === 'CASH_SESSION_CLOSED')
  assert.deepEqual(calls, ['session'])
})
test('deleting a receipt cannot remove money from an already closed turn', async () => {
  const row = { id: id(12), cash_register_session_id: id(4), branch_id: scope.branchId, customer_id: id(6), applications: [], commitments: [], allocation_events: [], refunds: [] }
  let deletes = 0
  const db = { customerPayment: { findFirst: async () => row, findUnique: async () => row, delete: async () => { deletes++ } }, journalEntry: { findFirst: async () => null },
    $queryRaw: async () => [session({ status: 'CLOSED' })], $executeRaw: async () => {} }
  db.$transaction = async work => work(db)
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve('../src/modules/receivables/controller'), async api => {
    let error
    await api.deletePayment({ companyId: scope.companyId, branchId: scope.branchId, params: { id: row.id }, user: { sub: scope.userId, permissions: ['receivables.cancel_payment'] } }, jsonResponse(), e => { error = e })
    assert.equal(error?.code, 'CASH_SESSION_CLOSED'); assert.equal(deletes, 0)
  })
})
test('changing a sale status cannot race past its cash-session cut', async () => {
  const current = { id: id(13), cash_register_session_id: id(4), branch_id: scope.branchId,
    status: { name: 'Completada' }, cashRegisterSession: { status: 'OPEN' }, sale_items: [], paymentEntries: [], status_id: 1 }
  const db = { saleStatus: { findFirst: async () => ({ id: 2, name: 'Cancelada' }) }, sale: { findFirst: async () => current },
    $queryRaw: async sql => String(sql).includes('cash_register_sessions') ? [session({ status: 'CLOSED' })] : [{ id: current.id }] }
  db.$transaction = async work => work(db)
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve('../src/modules/sales/controller'), async api => {
    let error
    await api.updateStatus({ companyId: scope.companyId, branchId: scope.branchId, params: { id: current.id }, body: { status_name: 'Cancelada' }, user: { sub: scope.userId, permissions: ['sales.cancel'] } }, jsonResponse(), e => { error = e })
    assert.equal(error?.code, 'CASH_SESSION_CLOSED', error?.message)
  })
})
