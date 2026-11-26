const test = require('node:test'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto'), { execFileSync, spawnSync } = require('node:child_process')
const { PrismaClient } = require('@prisma/client')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const qaUrl = process.env.AUNA_CASH_BOUNDARY_QA_URL
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const observe = promise => { promise.catch(() => {}); return promise }
const reached = (operation, event) => Promise.race([event.promise, operation.then(() => { throw Error('Operation completed before the expected lock barrier') })])

// Pause only after the real lock is held; PostgreSQL's blocking graph proves contention.
function instrument(db, { table = 'session', hold = false } = {}) {
  const attempted = deferred(), acquired = deferred(), release = deferred()
  const api = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key)
    return (work, options) => target.$transaction(async tx => {
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`
      return work(new Proxy(tx, { get(inner, property) {
        if (property !== '$queryRaw') return Reflect.get(inner, property)
        return async (sql, ...values) => {
          const text = String(sql), watched = table === 'register' ? text.includes('FROM cash_registers r') : text.includes('FROM cash_register_sessions s')
          if (watched) attempted.resolve(pid)
          const rows = await inner.$queryRaw(sql, ...values)
          if (watched) { acquired.resolve(pid); if (hold) await release.promise }
          return rows
        }
      } }))
    }, { ...options, timeout: 20000, maxWait: 5000 })
  } })
  return { db: api, attempted, acquired, release }
}
async function blockedBy(db, waiting, holder) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [{ blocked }] = await db.$queryRaw`SELECT ${holder}::int=ANY(pg_blocking_pids(${waiting}::int)) AS blocked`
    if (blocked) return
    await new Promise(setImmediate)
  }
  assert.fail('The expected row-lock dependency was never observed in PostgreSQL')
}
async function loadApi(db, target) {
  return withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db, prismaTransaction: db } }, require.resolve(target), api => api)
}
async function invoke(api, action, req) {
  const res = jsonResponse(); let error
  await api[action](req, res, e => { error = e })
  if (error) throw error
  return res
}
async function fixture(db) {
  const company = await db.company.create({ data: { name: 'Cash boundary QA', code: randomUUID().slice(0, 12) } })
  const branch = await db.branch.create({ data: { company_id: company.id, name: 'QA', code: 'QA' } })
  const role = await db.role.create({ data: { name: 'Cashier QA', company_id: company.id } })
  const user = await db.user.create({ data: { name: 'Cashier QA', email: `${randomUUID()}@example.invalid`, password: 'qa-not-a-login', role_id: role.id } })
  const customer = await db.supplier.create({ data: { company_id: company.id, name: 'Customer QA', contact: 'QA', party_type: 'CUSTOMER' } })
  const method = await db.paymentMethod.create({ data: { company_id: company.id, name: 'Cash QA', settlement_kind: 'CASH' } })
  const credit = await db.paymentMethod.create({ data: { company_id: company.id, name: 'Credit QA', is_credit: true, settlement_kind: 'CREDIT' } })
  for (const m of [method, credit]) await db.companyPaymentMethod.create({ data: { company_id: company.id, payment_method_id: m.id } })
  const status = await db.saleStatus.upsert({ where: { name: 'Completada' }, create: { name: 'Completada' }, update: {} })
  const register = await db.cashRegister.create({ data: { branch_id: branch.id, name: 'Physical QA', code: 'QA', is_default: true } })
  const session = await db.cashRegisterSession.create({ data: { cash_register_id: register.id, opened_by_id: user.id, opening_float: 200, opened_at: new Date(Date.now() - 60000) } })
  const sale = await db.sale.create({ data: { branch_id: branch.id, customer_contact_id: customer.id, status_id: status.id,
    payment_method_id: credit.id, total: 100, adjusted_total: 100, items: 0, payment_status: 'PENDING', created_by: user.id } })
  const scope = { companyId: company.id, branchId: branch.id, userId: user.id, isAdmin: false }
  const req = body => ({ companyId: company.id, branchId: branch.id, user: { sub: user.id, role, permissions: ['sales.create', 'receivables.manage', 'sales.cancel', 'returns.complete'] }, query: {}, body })
  const receive = client => client.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...scope,
    customerId: customer.id, amount: 25, paymentMethodId: method.id, cashRegisterSessionId: session.id, paidAt: new Date() }))
  return { company, branch, user, customer, method, status, register, session, sale, scope, req, receive }
}
async function service(db, f) {
  await db.systemSetting.create({ data: { company_id: f.company.id, key: 'inventory_services_enabled', value: 'true' } })
  const category = await db.productCategory.create({ data: { company_id: f.company.id, name: 'Services QA' } })
  const status = await db.stockStatus.upsert({ where: { name: 'Available QA' }, create: { name: 'Available QA' }, update: {} })
  return db.product.create({ data: { company_id: f.company.id, category_id: category.id, status_id: status.id, name: 'Service QA', kind: 'SERVICE', service_unit_label: 'Servicio', quantity_decimals: 0, price: 25, cost: 0 } })
}
function checkout(f, product) {
  return { ...f.req({ cash_register_id: f.register.id, payment_method_id: f.method.id, sales_channel: 'WHOLESALE', idempotency_key: randomUUID(), items: [{ product_id: product.id, qty: 1 }] }), query: { response: 'confirmation' } }
}

test('real cash-session boundary serializes sources and cuts without a database migration', { skip: !qaUrl, timeout: 90000 }, async t => {
  const url = new URL(qaUrl)
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/auna_cash_boundary_qa')
  const schema = `cash_boundary_${randomUUID().replaceAll('-', '')}`
  url.searchParams.set('schema', schema)
  process.env.DATABASE_URL = url.href; process.env.DIRECT_URL = url.href
  const ddl = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
    env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  }).replaceAll('"public"', `"${schema}"`)
  const setup = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', qaUrl], { input: ddl, encoding: 'utf8' })
  assert.equal(setup.status, 0, setup.stderr)
  const first = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] })
  const second = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] })
  const monitor = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] })
  try {
    await t.test('a real receipt commits before a waiting cut, including its allocation and paid balance', async () => {
      const f = await fixture(first), holder = instrument(first, { hold: true }), closer = instrument(second)
      const closeApi = await loadApi(closer.db, '../src/modules/sales/cashSessions.controller')
      const receipt = observe(f.receive(holder.db))
      const holderPid = await reached(receipt, holder.acquired)
      const cut = observe(invoke(closeApi, 'closeSession', f.req({ cash_register_id: f.register.id })))
      try { await blockedBy(monitor, await reached(cut, closer.attempted), holderPid) } finally { holder.release.resolve() }
      const [paid, closed] = await Promise.all([receipt, cut])
      assert.equal(closed.statusCode, 200)
      assert.equal((await first.customerPayment.findUnique({ where: { id: paid.paymentId } })).cash_register_session_id, f.session.id)
      assert.equal(await first.salePaymentEntry.count({ where: { customer_payment_id: paid.paymentId } }), 1)
      assert.equal((await first.sale.findUnique({ where: { id: f.sale.id } })).payment_status, 'PARTIAL')
    })
    await t.test('a real cut wins and the waiting receipt leaves no payment or allocation', async () => {
      const f = await fixture(first), closer = instrument(first, { hold: true }), writer = instrument(second)
      const closeApi = await loadApi(closer.db, '../src/modules/sales/cashSessions.controller')
      const cut = observe(invoke(closeApi, 'closeSession', f.req({ cash_register_id: f.register.id })))
      const holderPid = await reached(cut, closer.acquired)
      const receipt = observe(f.receive(writer.db))
      try { await blockedBy(monitor, await reached(receipt, writer.attempted), holderPid) } finally { closer.release.resolve() }
      assert.equal((await cut).statusCode, 200)
      await assert.rejects(receipt, e => e.code === 'CASH_SESSION_CLOSED')
      assert.equal(await first.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
      assert.equal(await first.salePaymentEntry.count({ where: { sale_id: f.sale.id } }), 0)
      assert.equal((await first.sale.findUnique({ where: { id: f.sale.id } })).payment_status, 'PENDING')
    })
    await t.test('a database lock timeout rolls the receipt transaction back without partial money', async () => {
      const f = await fixture(first), closer = instrument(first, { hold: true }), writer = instrument(second)
      const cash = await loadApi(closer.db, '../src/modules/sales/cashSessions.controller')
      const cut = observe(invoke(cash, 'closeSession', f.req({ cash_register_id: f.register.id })))
      const holderPid = await reached(cut, closer.acquired)
      const receipt = observe(writer.db.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '200ms'`
        return require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id,
          amount: 25, paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id })
      }))
      try {
        await blockedBy(monitor, await reached(receipt, writer.attempted), holderPid)
        await assert.rejects(receipt, e => e.code === 'P2010' && e.meta?.code === '55P03')
        assert.equal(await monitor.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
        assert.equal(await monitor.salePaymentEntry.count({ where: { sale_id: f.sale.id } }), 0)
      } finally { closer.release.resolve() }
      assert.equal((await cut).statusCode, 200)
    })
    await t.test('two real openings create only one session and an unrelated register remains usable', async () => {
      const f = await fixture(first), other = await fixture(first)
      await first.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const holder = instrument(first, { table: 'register', hold: true }), competitor = instrument(second, { table: 'register' })
      const openA = await loadApi(holder.db, '../src/modules/sales/cashSessions.controller'), openB = await loadApi(competitor.db, '../src/modules/sales/cashSessions.controller')
      const a = observe(invoke(openA, 'openSession', f.req({ cash_register_id: f.register.id, opening_float: 0 })))
      const holderPid = await reached(a, holder.acquired)
      const b = observe(invoke(openB, 'openSession', f.req({ cash_register_id: f.register.id, opening_float: 0 })))
      try {
        await blockedBy(monitor, await reached(b, competitor.attempted), holderPid)
        await other.receive(monitor)
      } finally { holder.release.resolve() }
      assert.deepEqual((await Promise.all([a, b])).map(r => r.statusCode), [201, 409])
      assert.equal(await first.cashRegisterSession.count({ where: { cash_register_id: f.register.id, status: 'OPEN' } }), 1)
      assert.equal(await first.customerPayment.count({ where: { branch_id: other.branch.id } }), 1)
    })
    await t.test('real joins reject a foreign company and another operator without writing money', async () => {
      const f = await fixture(first), foreign = await fixture(first), boundary = require('../src/services/cashSessionBoundary')
      await assert.rejects(first.$transaction(tx => boundary.lockScopedSession(tx, foreign.scope, f.session.id)), e => e.status === 404)
      await assert.rejects(first.$transaction(async tx => boundary.assertSessionOperation(await boundary.lockScopedSession(tx, f.scope, f.session.id), { ...f.scope, userId: foreign.user.id })), e => e.status === 403)
      assert.equal(await first.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
    })
    await t.test('a real POS sale is inside the cut, survives replay after closing, and a new attempt writes nothing', async () => {
      const f = await fixture(first), product = await service(first, f), holder = instrument(first, { hold: true }), closer = instrument(second)
      const sales = await loadApi(holder.db, '../src/modules/sales/controller'), cash = await loadApi(closer.db, '../src/modules/sales/cashSessions.controller')
      const req = checkout(f, product), sale = observe(invoke(sales, 'create', req))
      const holderPid = await reached(sale, holder.acquired)
      const cut = observe(invoke(cash, 'closeSession', f.req({ cash_register_id: f.register.id })))
      try { await blockedBy(monitor, await reached(cut, closer.attempted), holderPid) } finally { holder.release.resolve() }
      const original = await sale; assert.equal(original.statusCode, 201); assert.equal((await cut).statusCode, 200)
      const replay = await invoke(sales, 'create', req)
      assert.equal(replay.statusCode, 200); assert.equal(replay.body.id, original.body.id)
      const denied = await invoke(sales, 'create', { ...req, body: { ...req.body, idempotency_key: randomUUID() } })
      assert.equal(denied.statusCode, 403)
      assert.equal(await first.sale.count({ where: { branch_id: f.branch.id } }), 2)
      assert.equal(await first.saleItem.count({ where: { sale_id: original.body.id } }), 1)
      assert.equal(await first.stockMovement.count({ where: { branch_id: f.branch.id } }), 0)
      assert.equal(await first.journalEntry.count({ where: { company_id: f.company.id } }), 0)
      assert.equal(await first.hardwareDrawerIntent.count({ where: { branch_id: f.branch.id } }), 0)
    })
    await t.test('legacy cash still requires a turn while real credit offsets ignore a cached closed or invalid turn', async () => {
      const f = await fixture(first), product = await service(first, f)
      const cash = await loadApi(first, '../src/modules/sales/cashSessions.controller')
      assert.equal((await invoke(cash, 'closeSession', f.req({ cash_register_id: f.register.id }))).statusCode, 200)
      await first.paymentMethod.update({ where: { id: f.method.id }, data: { name: 'Efectivo USD', settlement_kind: null } })
      const sales = await loadApi(first, '../src/modules/sales/controller'), req = checkout(f, product)
      req.user.role = { name: 'admin', company_id: null, system_key: 'ADMIN' }
      await assert.rejects(invoke(sales, 'create', req), e => e.code === 'CASH_SESSION_REQUIRED')
      assert.equal(await first.sale.count({ where: { branch_id: f.branch.id } }), 1)
      const line = await first.saleItem.create({ data: { sale_id: f.sale.id, product_id: product.id, qty: 4, price: 25,
        net_total: 100, unit_cost: 0, item_kind: 'SERVICE', item_name: product.name, unit_label: 'Servicio', quantity_decimals: 0 } })
      const approved = await first.returnStatus.upsert({ where: { name: 'Aprobada' }, create: { name: 'Aprobada' }, update: {} })
      await first.returnStatus.upsert({ where: { name: 'Completada' }, create: { name: 'Completada' }, update: {} })
      for (const sessionId of [f.session.id, randomUUID(), 'not-a-turn']) {
        const returned = await first.return.create({ data: { sale_id: f.sale.id, total_refund: 25, status_id: approved.id,
          approved_resolution: 'REFUND_CASH', return_items: { create: { sale_item_id: line.id, product_id: product.id, qty_returned: 1, refund_amount: 25 } } }, include: { return_items: true } })
        const result = await require('../src/modules/returns/application').completeReturn(first, {
          id: returned.id, scope: { branch_id: f.branch.id }, companyId: f.company.id, userId: f.user.id, permissions: ['returns.complete'],
          payload: { idempotency_key: randomUUID(), lines: [{ return_item_id: returned.return_items[0].id }], settlement: { cash_register_session_id: sessionId } },
        })
        assert.equal(result._settlement.kind, 'CREDIT_OFFSET')
        assert.equal(result._settlement.cash_register_session_id, null)
      }
      assert.equal(await first.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
      assert.equal((await first.sale.findUnique({ where: { id: f.sale.id } })).adjusted_total.toFixed(2), '25.00')
    })
    await t.test('a real return shares the cut and its committed refund can be retried without another outgoing payment', async () => {
      const f = await fixture(first), product = await service(first, f), sales = await loadApi(first, '../src/modules/sales/controller')
      const sold = await invoke(sales, 'create', checkout(f, product)), line = await first.saleItem.findFirst({ where: { sale_id: sold.body.id } })
      const approved = await first.returnStatus.upsert({ where: { name: 'Aprobada' }, create: { name: 'Aprobada' }, update: {} })
      await first.returnStatus.upsert({ where: { name: 'Completada' }, create: { name: 'Completada' }, update: {} })
      const refund = await first.return.create({ data: { sale_id: sold.body.id, total_refund: 25, status_id: approved.id, requested_resolution: 'REFUND_CASH', approved_resolution: 'REFUND_CASH',
        return_items: { create: { sale_item_id: line.id, product_id: product.id, qty_returned: 1, refund_amount: 25 } } }, include: { return_items: true } })
      const params = { id: refund.id, scope: { branch_id: f.branch.id }, companyId: f.company.id, userId: f.user.id, permissions: ['returns.complete'],
        payload: { idempotency_key: randomUUID(), lines: [{ return_item_id: refund.return_items[0].id }], settlement: { payment_method_id: f.method.id, cash_register_session_id: f.session.id } } }
      const holder = instrument(first, { hold: true }), closer = instrument(second)
      const cash = await loadApi(closer.db, '../src/modules/sales/cashSessions.controller')
      const outgoing = observe(require('../src/modules/returns/application').completeReturn(holder.db, params))
      const holderPid = await reached(outgoing, holder.acquired)
      const cut = observe(invoke(cash, 'closeSession', f.req({ cash_register_id: f.register.id })))
      try { await blockedBy(monitor, await reached(cut, closer.attempted), holderPid) } finally { holder.release.resolve() }
      await outgoing; assert.equal((await cut).statusCode, 200)
      const replay = await require('../src/modules/returns/application').completeReturn(first, params)
      assert.equal(replay._idempotent, true)
      assert.equal(await first.returnSettlement.count({ where: { return_id: refund.id, kind: 'REFUND' } }), 1)
      assert.equal((await first.sale.findUnique({ where: { id: sold.body.id } })).adjusted_total.toFixed(2), '0.00')
    })
    await t.test('a real Agenda receipt cannot deadlock with a waiting receipt in the same turn and keeps its replay after closing', async () => {
      const f = await fixture(first), product = await service(first, f)
      for (const code of ['appointments', 'sales', 'receivables']) await first.companyModule.create({ data: { company_id: f.company.id, module_code: code, status: 'ACTIVE' } })
      await first.companyModule.create({ data: { company_id: f.company.id, module_code: 'accounting', status: 'DISABLED' } })
      const engagement = await first.appointmentEngagement.create({ data: { company_id: f.company.id, branch_id: f.branch.id, customer_id: f.customer.id, source: 'DIRECT', currency_code: 'GTQ', agreed_total: 100,
        commercial_snapshot: { orders: [] }, created_by: f.user.id, lines: { create: { product_id: product.id, item_kind: 'SERVICE', item_name: product.name, unit_label: 'Servicio', quantity_decimals: 0, qty: 1, unit_price: 100, line_total: 100 } } } })
      const scope = { ...f.scope, permissions: ['appointments.view', 'appointments.collect', 'appointments.refund', 'receivables.manage', 'receivables.view'] }
      const input = { amount: '25.00', paymentMethodId: f.method.id, currencyCode: 'GTQ', paidAt: new Date().toISOString(), cashRegisterSessionId: f.session.id, expectedVersion: engagement.version, idempotencyKey: randomUUID() }
      const holder = instrument(first, { hold: true }), writer = instrument(second), agenda = require('../src/modules/appointments/engagementPayments')
      const received = observe(agenda.collectEngagementPayment(holder.db, scope, engagement.id, input))
      const holderPid = await reached(received, holder.acquired)
      const receipt = observe(f.receive(writer.db))
      try { await blockedBy(monitor, await reached(receipt, writer.attempted), holderPid) } finally { holder.release.resolve() }
      const [original] = await Promise.all([received, receipt])
      const resolutions = require('../src/modules/appointments/engagementResolution')
      const requested = await resolutions.resolveEngagementFunds(first, scope, engagement.id, {
        action: 'REQUEST_REFUND', amount: '10.00', receiptId: original.receiptId, reason: 'Partial refund QA',
        expectedVersion: original.engagement.version, idempotencyKey: randomUUID(),
      })
      const refund = await first.customerPaymentRefund.findFirst({ where: { engagement_id: engagement.id, status: 'REQUESTED' } })
      const confirmation = { action: 'CONFIRM_REFUND', amount: '10.00', receiptId: original.receiptId, refundId: refund.id,
        paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, reason: 'Refund paid QA',
        expectedVersion: requested.version, idempotencyKey: randomUUID() }
      const outgoing = instrument(first, { hold: true }), closer = instrument(second)
      const confirmed = observe(resolutions.resolveEngagementFunds(outgoing.db, scope, engagement.id, confirmation))
      const refundPid = await reached(confirmed, outgoing.acquired)
      const cash = await loadApi(closer.db, '../src/modules/sales/cashSessions.controller')
      const cut = observe(invoke(cash, 'closeSession', f.req({ cash_register_id: f.register.id })))
      const duplicate = observe(resolutions.resolveEngagementFunds(monitor, scope, engagement.id, confirmation))
      try { await blockedBy(monitor, await reached(cut, closer.attempted), refundPid) } finally { outgoing.release.resolve() }
      const [paidRefund, sameRefund] = await Promise.all([confirmed, duplicate])
      assert.equal(paidRefund.version, sameRefund.version)
      assert.equal((await cut).statusCode, 200)
      const confirmedReplay = await resolutions.resolveEngagementFunds(first, scope, engagement.id, confirmation)
      assert.equal(confirmedReplay.version, paidRefund.version)
      assert.equal(await first.customerPaymentRefund.count({ where: { engagement_id: engagement.id, status: 'CONFIRMED' } }), 1)
      assert.equal(await first.paymentAllocationEvent.count({ where: { engagement_id: engagement.id, action: 'REFUNDED' } }), 1)
      const replay = await agenda.collectEngagementPayment(first, scope, engagement.id, input)
      assert.equal(replay.receiptId, original.receiptId)
      assert.equal(await first.customerPayment.count({ where: { branch_id: f.branch.id } }), 2)
    })
  } finally { await Promise.all([first.$disconnect(), second.$disconnect(), monitor.$disconnect()]) }
})
