const test = require('node:test'), assert = require('node:assert/strict')
const { qaSchema, fixture } = require('./helpers/cashMoneyEventsQa.cjs')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const qaUrl = process.env.AUNA_CASH_EVENTS_QA_URL
test('adoption and opening preserve historical sessions and cannot silently downgrade', { skip: !qaUrl, timeout: 90000 }, async t => {
  const { db } = await qaSchema(qaUrl)
  try {
    await t.test('canonical admin alone opts into a configured physical individual register, never an existing turn', async () => {
      const f = await fixture(db, 0), api = require('../src/services/cashEventAdoption')
      const configured = await db.cashRegister.create({ data: { branch_id: f.branch.id, name: 'New QA', code: 'NEW-QA' } })
      await db.$executeRaw`UPDATE cash_registers SET currency_code='GTQ' WHERE id=${configured.id}::uuid`
      const command = { expectedRevision: 1, eventVersion: 1 }, options = { adoptionEnabled: true }
      await assert.rejects(db.$transaction(tx => api.adoptRegister(tx, f.scope, configured.id, command, options)), e => e.status === 403)
      const admin = { ...f.scope, isAdmin: true }
      await assert.rejects(db.$transaction(tx => api.adoptRegister(tx, admin, configured.id, command, { adoptionEnabled: false })), e => e.status === 409)
      await assert.rejects(db.$transaction(tx => api.adoptRegister(tx, admin, f.register.id, command, options)), e => e.status === 409)
      const adopted = await db.$transaction(tx => api.adoptRegister(tx, admin, configured.id, command, options))
      assert.equal(adopted.money_event_version, 1)
      const [legacy] = await db.$queryRaw`SELECT money_event_version FROM cash_register_sessions WHERE id=${f.session.id}::uuid`
      assert.equal(legacy.money_event_version, 0)
      await assert.rejects(db.$transaction(tx => api.adoptRegister(tx, admin, configured.id, command, options)), e => e.status === 409)
    })
    await t.test('version1 opening freezes business date/timezone/currency even with adoption disabled later', async () => {
      const f = await fixture(db)
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const api = require('../src/services/cashEventAdoption')
      const session = await db.$transaction(async tx => {
        const register = await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, f.register.id)
        return api.openEventSession(tx, f.scope, register, { openingFloat: '0.00', notes: null, now: new Date('2026-10-29T03:00:00Z') })
      })
      assert.equal(session.money_event_version, 1); assert.equal(session.currency_code, 'GTQ'); assert.equal(session.business_timezone, 'America/Guatemala')
      assert.equal(session.business_date.toISOString().slice(0, 10), '2026-10-28')
      const [row] = await db.$queryRaw`SELECT money_event_version,currency_code,business_timezone FROM cash_register_sessions WHERE id=${session.id}::uuid`
      assert.equal(row.money_event_version, 1)
      await assert.rejects(db.cashRegisterSession.create({ data: { cash_register_id: f.register.id, opened_by_id: f.user.id, opening_float: 0 } }), /cash_event_session/)
    })
    await t.test('opening cash allocation is frozen even if its payment method is renamed or reclassified', async () => {
      const f = await fixture(db)
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const session = await db.$transaction(async tx => require('../src/services/cashEventAdoption').openEventSession(tx, f.scope,
        await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, f.register.id), { openingFloat: '200.00', notes: null }))
      assert.equal(session.opening_cash_method_id, f.method.id); assert.equal(session.opening_cash_method_name, 'Efectivo QA')
      await db.paymentMethod.update({ where: { id: f.method.id }, data: { name: 'Renamed digital', settlement_kind: 'BANK' } })
      const [row] = await db.$queryRaw`SELECT * FROM cash_register_sessions WHERE id=${session.id}::uuid`
      assert.equal(row.opening_cash_method_name, 'Efectivo QA')
    })
    await t.test('HTTP open ignores adoption flag for already-adopted boxes and transports frozen metadata', async () => {
      const f = await fixture(db), api = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/sales/cashSessions.controller'), api => api)
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const req = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: ['sales.create'] }, body: { cash_register_id: f.register.id, opening_float: '200.00' }, query: { cash_register_id: f.register.id } }
      const res = jsonResponse(); let error
      await api.openSession(req, res, e => { error = e }); if (error) throw error
      assert.equal(res.statusCode, 201); assert.equal(res.body.money_event_version, 1); assert.equal(res.body.currency_code, 'GTQ')
      const current = jsonResponse(); await api.getCurrent(req, current, e => { throw e })
      assert.equal(current.body.session.money_event_version, 1); assert.equal(current.body.session.business_timezone, 'America/Guatemala')
      const alias = { ...req, user: { ...req.user, role: { name: 'Admin', company_id: f.company.id } }, params: { id: f.register.id }, body: { expectedRevision: 1, eventVersion: 1 } }
      await api.adoptRegister(alias, jsonResponse(), e => { error = e })
      assert.equal(error.status, 403)
    })
    await t.test('ledger opening rejects NaN float and freezes opening time and owner', async () => {
      const f = await fixture(db)
      await assert.rejects(db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,status,
        register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version,opening_cash_method_id,opening_cash_method_name)
        VALUES(${require('node:crypto').randomUUID()}::uuid,${f.register.id}::uuid,${f.user.id}::uuid,'NaN',now(),'CLOSED','PHYSICAL','INDIVIDUAL','GTQ','2026-10-28','America/Guatemala',1,${f.method.id},${f.method.name})`, /cash_event_session_snapshot/)
      await assert.rejects(db.$executeRaw`UPDATE cash_register_sessions SET opened_at=opened_at-interval '1 hour' WHERE id=${f.session.id}::uuid`, /cash_event_session/)
      const other = await db.user.create({ data: { name: 'Other QA', email: `${require('node:crypto').randomUUID()}@example.invalid`, password: 'qa', role_id: f.user.role_id } })
      await assert.rejects(db.$executeRaw`UPDATE cash_register_sessions SET opened_by_id=${other.id}::uuid WHERE id=${f.session.id}::uuid`, /cash_event_session/)
    })
    await t.test('own ledger reads frozen events, mixed period excludes their mutable sources and never repeats float', async () => {
      const f = await fixture(db)
      await db.$transaction(async tx => { const session = await f.locked(tx), receipt = await f.receipt(tx); await require('../src/modules/cash-closure/events').recordMoneyEvent(tx, f.scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: receipt.id }) })
      const legacyRegister = await db.cashRegister.create({ data: { branch_id: f.branch.id, name: 'Legacy QA', code: 'LEGACY' } })
      const legacySession = await db.cashRegisterSession.create({ data: { cash_register_id: legacyRegister.id, opened_by_id: f.user.id, opening_float: 0 } })
      await db.customerPayment.create({ data: { branch_id: f.branch.id, customer_id: f.customer.id, registered_by: f.user.id, amount: 30, payment_method_id: f.method.id, cash_register_session_id: legacySession.id } })
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      await db.paymentMethod.update({ where: { id: f.method.id }, data: { name: 'Now bank', settlement_kind: 'BANK' } })
      const req = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: ['cashclosure.create_own', 'cashclosure.create_day'] }, query: { cashier_id: f.user.id, cash_register_session_id: f.session.id } }
      const api = require('../src/modules/cash-closure/theoretical')
      const own = await api.calculateTheoreticalData(db, req)
      assert.equal(own.calculation_basis, 'EVENTS_V1'); assert.equal(own.theoretical.net_total, 250); assert.equal(own.cash_session.expected_cash_in_drawer, 250)
      assert.equal(own.payment_breakdown[0].settlement_kind, 'CASH'); assert.equal(own.payment_breakdown[0].payment_method_name, 'Efectivo QA')
      const startDate = new Date(Date.now() - 86400000).toISOString(), endDate = new Date(Date.now() + 86400000).toISOString()
      const mixed = await api.calculateTheoreticalData(db, { ...req, query: { startDate, endDate } })
      assert.equal(mixed.calculation_basis, 'MIXED'); assert.equal(mixed.theoretical.net_total, 80); assert.equal(mixed.event_count, 1)
      assert.deepEqual(mixed.payment_breakdown.map(m => [m.breakdown_key, m.theoretical_amount]).sort(), [[`${f.method.id}:BANK`, 30], [`${f.method.id}:CASH`, 50]].sort())
      assert.notEqual(mixed.calculation_key, own.calculation_key)
      const controller = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/controller'), api => api)
      const save = jsonResponse(); let error
      await controller.create({ ...req, body: { cashierId: f.user.id, cash_register_session_id: f.session.id, calculationKey: own.calculation_key, actualTotal: 250,
        paymentBreakdowns: own.payment_breakdown.map(row => ({ ...row, actual_amount: row.theoretical_amount })), denominations: [{ type: 'Billete', denomination: 50, quantity: 5 }] } }, save, e => { error = e }); if (error) throw error
      assert.equal(save.statusCode, 201); assert.equal(save.body.calculation_snapshot.basis, 'EVENTS_V1')
      assert.equal(save.body.payment_breakdowns[0].payment_method.name, 'Efectivo QA'); assert.equal(save.body.payment_breakdowns[0].settlement_kind, 'CASH')
      assert.equal(save.body.denominations.length, 1); assert.equal(Number(save.body.denominations[0].subtotal), 250)
      await assert.rejects(db.cashClosureDenomination.update({ where: { id: save.body.denominations[0].id }, data: { quantity: 6 } }), /cash_closure_snapshot/)
      const detail = jsonResponse(); await controller.getById({ ...req, params: { id: save.body.id } }, detail, e => { throw e })
      assert.equal(detail.body.payment_breakdowns[0].payment_method.name, 'Efectivo QA')
    })
  } finally { await db.$disconnect() }
})
test('new code operates legacy turns without the additive event schema', { skip: !qaUrl, timeout: 90000 }, async () => {
  const { db, apply } = await qaSchema(qaUrl, { migrate: false })
  try {
    const f = await fixture(db, 0)
    await assert.rejects(db.$transaction(tx => require('../src/modules/receivables/paymentAttempts').beginPaymentAttempt(tx, f.scope,
      { request_key: require('node:crypto').randomUUID(), customer_id: f.customer.id, amount: 50, payment_method_id: f.method.id })), e => e.code === 'PAYMENT_ATTEMPTS_UNAVAILABLE')
    const payment = await db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 50, paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, allowAdvance: true }))
    assert.ok(payment.paymentId)
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
    // El cálculo usa el cliente generado actual, que lee columnas de 2B.2 (ya aplicada en la base activa): el turno legado se calcula tras migrar.
    apply()
    const theory = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, { companyId: f.company.id, branchId: f.branch.id,
      user: { sub: f.user.id, permissions: ['cashclosure.create_own'] }, query: { cashier_id: f.user.id, cash_register_session_id: f.session.id } })
    assert.equal(theory.calculation_basis, 'LEGACY'); assert.equal(theory.theoretical.net_total, 250)
  } finally { await db.$disconnect() }
})
