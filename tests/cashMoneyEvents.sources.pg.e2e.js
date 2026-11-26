const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture } = require('./helpers/cashMoneyEventsQa.cjs')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const qaUrl = process.env.AUNA_CASH_EVENTS_QA_URL
async function salesApi(db) {
  return withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve('../src/modules/sales/controller'), api => api)
}
async function invoke(api, req) {
  const res = jsonResponse(); let error
  await api.create(req, res, e => { error = e }); if (error) throw error; return res
}
async function service(db, f) {
  await db.systemSetting.create({ data: { company_id: f.company.id, key: 'inventory_services_enabled', value: 'true' } })
  const category = await db.productCategory.create({ data: { company_id: f.company.id, name: 'Services QA' } })
  const status = await db.stockStatus.upsert({ where: { name: 'Available QA' }, create: { name: 'Available QA' }, update: {} })
  return db.product.create({ data: { company_id: f.company.id, category_id: category.id, status_id: status.id, name: 'Service QA', kind: 'SERVICE', service_unit_label: 'Servicio', quantity_decimals: 0, price: 100, cost: 0 } })
}
function request(f, product, extra = {}) {
  return { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: ['sales.create'] }, query: { response: 'confirmation' },
    body: { cash_register_id: f.register.id, payment_method_id: f.method.id, idempotency_key: randomUUID(), sales_channel: 'WHOLESALE', items: [{ product_id: product.id, qty: 1 }], ...extra } }
}
test('real money writers create only canonical events in the same transaction as their sources', { skip: !qaUrl, timeout: 90000 }, async t => {
  const { db } = await qaSchema(qaUrl)
  try {
    await db.saleStatus.upsert({ where: { name: 'Completada' }, create: { name: 'Completada' }, update: {} })
    await t.test('POS freezes only the net price, not tendered cash, and checkout replay adds nothing', async () => {
      const f = await fixture(db), p = await service(db, f), api = await salesApi(db), req = request(f, p, { amount_received: 200, change: 100 })
      const sold = await invoke(api, req); assert.equal(sold.statusCode, 201)
      const replay = await invoke(api, req); assert.equal(replay.body.id, sold.body.id)
      const rows = await db.$queryRaw`SELECT amount,source_type FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
      assert.equal(rows.length, 1); assert.equal(rows[0].source_type, 'SALE'); assert.equal(rows[0].amount.toFixed(2), '100.00')
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      assert.equal((await invoke(api, req)).body.id, sold.body.id)
    })
    await t.test('receivable domain records a receipt once, not again when its available credit is applied', async () => {
      const f = await fixture(db)
      const result = await db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id,
        amount: 50, paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, allowAdvance: true }))
      await db.$transaction(tx => require('../src/modules/receivables').applyAvailableCredit(tx, f.customer.id, f.branch.id))
      const rows = await db.$queryRaw`SELECT amount,source_type,source_id FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
      assert.equal(rows.length, 1); assert.equal(rows[0].source_id, result.paymentId); assert.equal(rows[0].source_type, 'CUSTOMER_PAYMENT')
    })
    await t.test('ledger POS without a stable key fails before creating money', async () => {
      const f = await fixture(db), p = await service(db, f), req = request(f, p); delete req.body.idempotency_key
      await assert.rejects(invoke(await salesApi(db), req), e => e.status === 428)
      assert.equal(await db.sale.count({ where: { branch_id: f.branch.id } }), 0)
    })
    await t.test('Agenda receipt and confirmed refund record money, reservations and requests do not', async () => {
      const f = await fixture(db), api = require('../src/modules/receivables/engagementPayments')
      await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'accounting', status: 'DISABLED' } })
      const e = await db.appointmentEngagement.create({ data: { company_id: f.company.id, branch_id: f.branch.id, customer_id: f.customer.id,
        source: 'DIRECT', currency_code: 'GTQ', agreed_total: 100, commercial_snapshot: {}, created_by: f.user.id } })
      const input = { amount: '50.00', currencyCode: 'GTQ', paidAt: new Date().toISOString(), paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, idempotencyKey: randomUUID() }
      const receipt = await db.$transaction(tx => api.receiveEngagementPayment(tx, f.scope, e, input))
      const refundInput = { action: 'REQUEST_REFUND', receiptId: receipt.id, amount: '20.00', reason: 'QA refund', idempotencyKey: randomUUID() }
      await db.$transaction(tx => api.resolveReservedFunds(tx, f.scope, e, refundInput))
      let rows = await db.$queryRaw`SELECT source_type,direction,amount FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
      assert.equal(rows.length, 1); assert.equal(rows[0].source_type, 'CUSTOMER_PAYMENT')
      const refund = await db.customerPaymentRefund.findFirst({ where: { payment_id: receipt.id } })
      await db.$transaction(tx => api.resolveReservedFunds(tx, f.scope, e, { ...refundInput, ...input, amount: '20.00', action: 'CONFIRM_REFUND', refundId: refund.id, idempotencyKey: randomUUID() }))
      rows = await db.$queryRaw`SELECT source_type,direction,amount FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid ORDER BY recorded_at`
      assert.deepEqual(rows.map(r => [r.source_type, r.direction, r.amount.toFixed(2)]), [['CUSTOMER_PAYMENT', 'IN', '50.00'], ['CUSTOMER_PAYMENT_REFUND', 'OUT', '20.00']])
    })
    await t.test('separate order invoice freezes a direct sale and rejects changed intent after closing', async () => {
      const f = await fixture(db), p = await service(db, f)
      const order = await db.commercialDocument.create({ data: { branch_id: f.branch.id, doc_type: 'ORDER', status: 'FULFILLED', fulfillment_mode: 'SEPARATE', total: 100,
        lines: { create: [{ product_id: p.id, qty: 1, qty_fulfilled: 1, item_name: p.name, item_kind: 'SERVICE', unit_label: 'Servicio', unit_price: 100, line_total: 100 }] } }, include: { lines: true } })
      await db.orderDelivery.create({ data: { document_id: order.id, request_key: randomUUID(), created_by: f.user.id,
        lines: { create: [{ document_line_id: order.lines[0].id, qty: 1, unit_cost: 0 }] } } })
      const req = { ...request(f, p), params: { id: order.id }, body: { request_key: randomUUID(), payment_method_id: f.method.id, amount_received: 100, cash_register_id: f.register.id, lines: [{ line_id: order.lines[0].id, qty: 1 }] } }
      const invoice = () => db.$transaction(tx => require('../src/modules/orders/fulfillment').invoice(tx, req, () => f.locked(tx)))
      const result = await invoice()
      const rows = await db.$queryRaw`SELECT amount,source_id FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
      assert.equal(rows.length, 1); assert.equal(rows[0].source_id, result.sale.id); assert.equal(rows[0].amount.toFixed(2), '100.00')
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      assert.equal((await invoice()).sale.id, result.sale.id)
      req.body.amount_received = 200
      await assert.rejects(invoice(), e => e.status === 409)
    })
    await t.test('a real return preserves the original collection and writes only its refund', async () => {
      const f = await fixture(db), p = await service(db, f), sold = await invoke(await salesApi(db), request(f, p, { amount_received: 100, change: 0 }))
      const item = await db.saleItem.findFirst({ where: { sale_id: sold.body.id } })
      const approved = await db.returnStatus.upsert({ where: { name: 'Aprobada' }, create: { name: 'Aprobada' }, update: {} })
      await db.returnStatus.upsert({ where: { name: 'Completada' }, create: { name: 'Completada' }, update: {} })
      const returned = await db.return.create({ data: { sale_id: sold.body.id, status_id: approved.id, total_refund: 20, approved_resolution: 'REFUND_CASH', return_items: { create: [{ sale_item_id: item.id, product_id: p.id, qty_returned: 1, refund_amount: 20 }] } }, include: { return_items: true } })
      const command = { id: returned.id, scope: { branch_id: f.branch.id, branch: { company_id: f.company.id } }, companyId: f.company.id, userId: f.user.id, permissions: ['returns.complete'],
        payload: { idempotency_key: randomUUID(), lines: [{ return_item_id: returned.return_items[0].id }], settlement: { payment_method_id: f.method.id, cash_register_session_id: f.session.id } } }
      const run = () => require('../src/modules/returns/application').completeReturn(db, command)
      await run(); await run()
      const rows = await db.$queryRaw`SELECT source_type,direction,amount FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid ORDER BY recorded_at`
      assert.deepEqual(rows.map(r => [r.source_type, r.direction, r.amount.toFixed(2)]), [['SALE', 'IN', '100.00'], ['RETURN_SETTLEMENT', 'OUT', '20.00']])
    })
    await t.test('ordinary receipt retries share one source, reject changed content and recover after closing', async () => {
      const f = await fixture(db)
      const body = { customer_id: f.customer.id, amount: '50.00', payment_method_id: f.method.id, cash_register_session_id: f.session.id, allow_advance: true, request_key: randomUUID() }
      const run = () => db.$transaction(async tx => {
        const attempt = await require('../src/modules/receivables/paymentAttempts').beginPaymentAttempt(tx, f.scope, body)
        if (attempt?.paymentId) return attempt.paymentId
        return (await require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: body.amount, paymentMethodId: f.method.id,
          cashRegisterSessionId: f.session.id, allowAdvance: true, externalRequest: true, requestAttempt: attempt })).paymentId
      })
      const ids = await Promise.all([run(), run()]); assert.equal(ids[0], ids[1])
      assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 1)
      body.amount = '51.00'; await assert.rejects(run(), e => e.status === 409); body.amount = '50.00'
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      assert.equal(await run(), ids[0])
      const rows = await db.$queryRaw`SELECT source_id FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
      assert.equal(rows.length, 1); assert.equal(rows[0].source_id, ids[0])
    })
    await t.test('ordinary receipt without key is rejected in version1 but legacy stays compatible', async () => {
      for (const version of [1, 0]) {
        const f = await fixture(db, version)
        const run = () => db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 50,
          paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, allowAdvance: true, externalRequest: true }))
        if (version === 1) { await assert.rejects(run(), e => e.status === 428); assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 0) }
        else assert.ok((await run()).paymentId)
      }
    })
    await t.test('credit sale itself is not money; its initial receipt is counted once', async () => {
      for (const initial of [0, 50]) {
        const f = await fixture(db), p = await service(db, f)
        await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'receivables', status: 'ACTIVE' } })
        const credit = await db.paymentMethod.create({ data: { company_id: f.company.id, name: 'Credit QA', is_credit: true, settlement_kind: 'CREDIT' } })
        await db.companyPaymentMethod.create({ data: { company_id: f.company.id, payment_method_id: credit.id } })
        const req = request(f, p, { customer_contact_id: f.customer.id, payment_method_id: credit.id, due_date: '2026-12-31', ...(initial ? { initial_payment: { amount: initial, payment_method_id: f.method.id } } : {}) })
        await invoke(await salesApi(db), req)
        const rows = await db.$queryRaw`SELECT source_type,amount FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`
        assert.equal(rows.length, initial ? 1 : 0)
        if (initial) { assert.equal(rows[0].source_type, 'CUSTOMER_PAYMENT'); assert.equal(rows[0].amount.toFixed(2), '50.00') }
      }
    })
    await t.test('ordinary controller uses the attempt before OPEN and explains why ledger receipts cannot be deleted', async () => {
      const f = await fixture(db)
      const api = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve('../src/modules/receivables/controller'), api => api)
      const req = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: ['receivables.manage', 'receivables.cancel_payment'] },
        body: { customer_id: f.customer.id, amount: 50, payment_method_id: f.method.id, cash_register_session_id: f.session.id, allow_advance: true, request_key: randomUUID() } }
      async function call(fn, request) { const res = jsonResponse(); let error; await fn(request, res, e => { error = e }); if (error) throw error; return res.body }
      const receipt = await call(api.createPayment, req)
      await assert.rejects(call(api.deletePayment, { ...req, params: { id: receipt.id } }), e => e.status === 409 && /registro de caja/.test(e.message))
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      assert.equal((await call(api.createPayment, req)).id, receipt.id)
      req.body.amount = 60
      await assert.rejects(call(api.createPayment, req), e => e.status === 409)
      assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 1)
    })
    await t.test('exchanges count only the difference, equal and customer-credit exchanges add no money', async () => {
      for (const price of [115, 100, 85]) {
        const f = await fixture(db), p = await service(db, f), sold = await invoke(await salesApi(db), request(f, p, { customer_contact_id: f.customer.id, amount_received: 100, change: 0 }))
        const item = await db.saleItem.findFirst({ where: { sale_id: sold.body.id } })
        const approved = await db.returnStatus.upsert({ where: { name: 'Aprobada' }, create: { name: 'Aprobada' }, update: {} })
        await db.product.update({ where: { id: p.id }, data: { price } })
        const returned = await db.return.create({ data: { sale_id: sold.body.id, type: 'EXCHANGE', status_id: approved.id, total_refund: 100, approved_resolution: 'EXCHANGE',
          return_items: { create: [{ sale_item_id: item.id, product_id: p.id, qty_returned: 1, refund_amount: 100 }] },
          replacement_items: { create: [{ product_id: p.id, qty: 1, item_name: p.name, item_kind: 'SERVICE', unit_label: 'Servicio', unit_price: price, line_total: price }] } }, include: { return_items: true } })
        const command = { id: returned.id, scope: { branch_id: f.branch.id, branch: { company_id: f.company.id } }, ...f.scope, permissions: ['returns.complete'],
          payload: { idempotency_key: randomUUID(), lines: [{ return_item_id: returned.return_items[0].id }], settlement: { channel: price < 100 ? 'CUSTOMER_CREDIT' : 'CASH', payment_method_id: f.method.id, cash_register_session_id: f.session.id } } }
        await require('../src/modules/returns/application').completeReturn(db, command)
        const rows = await db.$queryRaw`SELECT source_type,amount FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid ORDER BY recorded_at`
        assert.equal(rows.length, price > 100 ? 2 : 1)
        if (price > 100) { assert.equal(rows[1].source_type, 'RETURN_SETTLEMENT'); assert.equal(rows[1].amount.toFixed(2), '15.00') }
      }
    })
  } finally { await db.$disconnect() }
})
