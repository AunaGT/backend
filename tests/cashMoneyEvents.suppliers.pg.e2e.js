const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture } = require('./helpers/cashMoneyEventsQa.cjs')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const qaUrl = process.env.AUNA_CASH_EVENTS_QA_URL
async function payable(db, version = 1) {
  const f = await fixture(db, version)
  f.scope.permissions = ['merchandise.details', 'merchandise.mark_paid', 'merchandise.cancel_payment', 'cashclosure.create_own']; f.scope.branchIds = [f.branch.id]
  await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'merchandise', status: 'ACTIVE' } })
  const vendor = await db.supplier.create({ data: { company_id: f.company.id, name: 'Supplier QA', contact: 'QA' } })
  const category = await db.productCategory.create({ data: { company_id: f.company.id, name: 'Goods' } })
  const status = await db.stockStatus.upsert({ where: { name: 'Available QA' }, create: { name: 'Available QA' }, update: {} })
  const product = await db.product.create({ data: { company_id: f.company.id, category_id: category.id, status_id: status.id, name: 'QA supply', price: 70, cost: 50 } })
  const entry = await db.incomingMerchandise.create({ data: { branch_id: f.branch.id, supplier_id: vendor.id, registered_by: f.user.id,
    items: { create: [{ product_id: product.id, quantity: 1, unit_cost: 50 }] } } })
  const input = { requestKey: randomUUID(), supplierId: vendor.id, amount: '50.00', currencyCode: 'GTQ', paidAt: new Date().toISOString(), paymentMethodId: f.method.id,
    applications: [{ incomingId: entry.id, amount: '50.00', expectedRevision: 0 }] }
  return { ...f, vendor, entry, input }
}
test('supplier payments join cash only by explicit selection and preserve canonical outflows', { skip: !qaUrl, timeout: 90000 }, async t => {
  const { db } = await qaSchema(qaUrl)
  const api = require('../src/modules/merchandise/payables/payments')
  try {
    await t.test('outside cash stays unassigned and omitted/null replay is backward compatible', async () => {
      const f = await payable(db), first = await api.createSupplierPayment(db, f.scope, f.input)
      assert.equal(first.cashRegisterSessionId, null)
      assert.equal((await api.createSupplierPayment(db, f.scope, { ...f.input, cashRegisterSessionId: null })).id, first.id)
      assert.equal((await db.$queryRaw`SELECT id FROM cash_money_events WHERE branch_id=${f.branch.id}::uuid`).length, 0)
    })
    await t.test('linked version1 writes one OUT, replays after closing and documentary cancellation does not refund', async () => {
      const f = await payable(db), input = { ...f.input, cashRegisterSessionId: f.session.id }
      const [a, b] = await Promise.all([api.createSupplierPayment(db, f.scope, input), api.createSupplierPayment(db, f.scope, input)])
      assert.equal(a.id, b.id); assert.equal(a.cashRegisterSessionId, f.session.id)
      const rows = await db.$queryRaw`SELECT source_type,direction,amount FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
      assert.deepEqual(rows.map(r => [r.source_type, r.direction, r.amount.toFixed(2)]), [['SUPPLIER_PAYMENT', 'OUT', '50.00']])
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      assert.equal((await api.createSupplierPayment(db, f.scope, input)).id, a.id)
      await assert.rejects(api.createSupplierPayment(db, f.scope, { ...input, cashRegisterSessionId: randomUUID() }), e => e.status === 409)
      await require('../src/modules/merchandise/payables/corrections').cancelSupplierPayment(db, f.scope, a.id, { reason: 'Corrección documental, no retorno físico' })
      const own = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: f.scope.permissions }, query: { cashier_id: f.user.id, cash_register_session_id: f.session.id } })
      assert.equal(own.theoretical.total_supplier_payments, 50); assert.equal(own.cash_session.expected_cash_in_drawer, 150)
    })
    await t.test('a bank-only net outflow closes with its signed amount and zero discrepancy', async () => {
      const f = await payable(db)
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      await db.paymentMethod.update({ where: { id: f.method.id }, data: { name: 'Transferencia QA', settlement_kind: 'BANK' } })
      const session = await db.$transaction(async tx => require('../src/services/cashEventAdoption').openEventSession(tx, f.scope,
        await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, f.register.id), { openingFloat: '0.00', notes: null }))
      await api.createSupplierPayment(db, f.scope, { ...f.input, cashRegisterSessionId: session.id })
      await db.cashRegisterSession.update({ where: { id: session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const req = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: f.scope.permissions }, query: { cashier_id: f.user.id, cash_register_session_id: session.id } }
      const own = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, req)
      assert.equal(own.theoretical.net_total, -50); assert.equal(own.cash_session.expected_cash_in_drawer, 0)
      const controller = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/controller'), api => api)
      const res = jsonResponse(); let error
      await controller.create({ ...req, body: { cashierId: f.user.id, cash_register_session_id: session.id, calculationKey: own.calculation_key, actualTotal: -50,
        paymentBreakdowns: own.payment_breakdown.map(row => ({ ...row, actual_amount: row.theoretical_amount })), denominations: [] } }, res, e => { error = e })
      if (error) throw error
      assert.equal(res.statusCode, 201, JSON.stringify(res.body)); assert.equal(Number(res.body.difference), 0)
      assert.equal(Number(res.body.payment_breakdowns[0].actual_amount), -50); assert.equal(res.body.calculation_snapshot.payment_breakdowns[0].settlement_kind, 'BANK')
    })
    await t.test('closed, foreign session and wrong currency fail without payment/application/audit', async () => {
      for (const reason of ['closed', 'foreign', 'currency']) {
        const f = await payable(db), input = { ...f.input, cashRegisterSessionId: f.session.id }
        if (reason === 'closed') await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
        if (reason === 'foreign') input.cashRegisterSessionId = (await fixture(db)).session.id
        if (reason === 'currency') input.currencyCode = 'USD'
        await assert.rejects(api.createSupplierPayment(db, f.scope, input))
        assert.equal(await db.supplierPayment.count({ where: { branch_id: f.branch.id } }), 0)
        assert.equal(await db.incomingMerchandisePaymentEntry.count({ where: { incoming_merchandise_id: f.entry.id } }), 0)
        assert.equal(await db.merchandisePaymentAuditEvent.count({ where: { incoming_merchandise_id: f.entry.id } }), 0)
      }
    })
    await t.test('explicit legacy session participates as an outgoing payment without inventing an event', async () => {
      const f = await payable(db, 0)
      await api.createSupplierPayment(db, f.scope, { ...f.input, cashRegisterSessionId: f.session.id })
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const own = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: f.scope.permissions }, query: { cashier_id: f.user.id, cash_register_session_id: f.session.id } })
      assert.equal(own.theoretical.total_supplier_payments, 50); assert.equal(own.theoretical.net_total, 150)
    })
    await t.test('payment options expose only own open turns, without balances or broad cash permissions', async () => {
      const f = await payable(db)
      const other = await db.user.create({ data: { name: 'Other QA', email: `${randomUUID()}@example.invalid`, password: 'qa', role_id: f.user.role_id } })
      const box = await db.cashRegister.create({ data: { branch_id: f.branch.id, name: 'Other box', code: 'OTHER' } })
      await db.cashRegisterSession.create({ data: { cash_register_id: box.id, opened_by_id: other.id, opening_float: 999 } })
      const api = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/sales/cashSessions.controller'), api => api)
      const res = jsonResponse(), req = { companyId: f.company.id, branchId: f.branch.id, branchIds: [f.branch.id], user: { sub: f.user.id, permissions: ['merchandise.mark_paid'] } }
      await api.paymentOptions(req, res, e => { throw e })
      assert.equal(res.body.available, true); assert.equal(res.body.sessions.length, 1); assert.equal(res.body.sessions[0].id, f.session.id)
      assert.equal('opening_float' in res.body.sessions[0], false)
      let error; await api.paymentOptions({ ...req, user: { ...req.user, permissions: ['sales.view'] } }, jsonResponse(), e => { error = e }); assert.equal(error.status, 403)
    })
  } finally { await db.$disconnect() }
})
