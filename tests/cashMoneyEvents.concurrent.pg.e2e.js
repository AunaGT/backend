const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { PrismaClient } = require('@prisma/client'), { qaSchema, fixture } = require('./helpers/cashMoneyEventsQa.cjs')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const qaUrl = process.env.AUNA_CASH_EVENTS_QA_URL
const signal = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise } }
function instrument(db, hold = false) {
  const attempted = signal(), acquired = signal(), release = signal()
  return { attempted, acquired, release, db: new Proxy(db, { get(target, name) {
    if (name !== '$transaction') return Reflect.get(target, name)
    return (work, options) => target.$transaction(async tx => {
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`
      return work(new Proxy(tx, { get(inner, key) {
        if (key !== '$queryRaw') return Reflect.get(inner, key)
        return async (sql, ...values) => {
          const watched = String(sql).includes('FROM cash_register_sessions s') && String(sql).includes('FOR UPDATE OF s')
          if (watched) attempted.resolve(pid)
          const result = await inner.$queryRaw(sql, ...values)
          if (watched) { acquired.resolve(pid); if (hold) await release.promise }
          return result
        }
      } }))
    }, { ...options, timeout: 15000, maxWait: 5000 })
  } }) }
}
async function blockedBy(db, waiter, holder) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const [{ blocked }] = await db.$queryRaw`SELECT ${holder}::int=ANY(pg_blocking_pids(${waiter}::int)) AS blocked`
    if (blocked) return
    await new Promise(setImmediate)
  }
  assert.fail('Expected PostgreSQL row-lock dependency was not observed')
}
const observed = promise => { promise.catch(() => {}); return promise }
const reached = (operation, point) => Promise.race([point.promise, operation.then(() => { throw Error('Operation finished before the lock barrier') })])
const receive = (db, f, extra = {}) => db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 50, paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, allowAdvance: true, ...extra }))
async function close(db, f) {
  return withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/sales/cashSessions.controller'), async api => {
    const res = jsonResponse(); let error
    await api.closeSession({ companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, permissions: ['sales.create'] }, body: { cash_register_id: f.register.id } }, res, e => { error = e })
    if (error) throw error
    return res
  })
}
test('real PostgreSQL ledger races keep source and event on the same side of a cut', { skip: !qaUrl, timeout: 90000 }, async t => {
  const { db, url } = await qaSchema(qaUrl), second = new PrismaClient({ datasources: { db: { url } }, log: [] }), monitor = new PrismaClient({ datasources: { db: { url } }, log: [] })
  try {
    await t.test('receipt and its canonical event commit before a waiting cut', async () => {
      const f = await fixture(db), holder = instrument(db, true), closer = instrument(second)
      const receipt = observed(receive(holder.db, f)), holderPid = await reached(receipt, holder.acquired), cut = observed(close(closer.db, f))
      try { await blockedBy(monitor, await reached(cut, closer.attempted), holderPid) } finally { holder.release.resolve() }
      await receipt; assert.equal((await cut).statusCode, 200)
      const rows = await db.$queryRaw`SELECT e.id FROM cash_money_events e JOIN customer_payments p ON p.id=e.customer_payment_id WHERE e.cash_register_session_id=${f.session.id}::uuid`
      assert.equal(rows.length, 1)
    })
    await t.test('cut wins and rejects all money effects of the waiting receipt', async () => {
      const f = await fixture(db), holder = instrument(db, true), writer = instrument(second)
      const cut = observed(close(holder.db, f)), holderPid = await reached(cut, holder.acquired), receipt = observed(receive(writer.db, f))
      try { await blockedBy(monitor, await reached(receipt, writer.attempted), holderPid) } finally { holder.release.resolve() }
      await cut; await assert.rejects(receipt, e => e.code === 'CASH_SESSION_CLOSED')
      assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
      assert.equal((await db.$queryRaw`SELECT id FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`).length, 0)
    })
    await t.test('independent box in the same branch completes while the first box is held', async () => {
      const f = await fixture(db), holder = instrument(db, true)
      const register = await db.cashRegister.create({ data: { branch_id: f.branch.id, name: 'Second box', code: 'SECOND' } })
      await db.$executeRaw`UPDATE cash_registers SET currency_code='GTQ',money_event_version=1 WHERE id=${register.id}::uuid`
      const session = await db.$transaction(async tx => require('../src/services/cashEventAdoption').openEventSession(tx, f.scope, await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, register.id), { openingFloat: 0, notes: null }))
      const first = observed(receive(holder.db, f)); await reached(first, holder.acquired)
      try {
        const other = await Promise.race([receive(second, { ...f, register, session }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Unrelated box stalled')), 3000); timer.unref() })])
        assert.ok(other.paymentId)
      } finally { holder.release.resolve() }
      await first
    })
    await t.test('real lock timeout rolls back all effects and does not poison the next attempt', async () => {
      const f = await fixture(db), holder = instrument(db, true), first = observed(receive(holder.db, f)); await reached(first, holder.acquired)
      try {
        await assert.rejects(second.$transaction(async tx => { await tx.$executeRaw`SET LOCAL lock_timeout='150ms'`; return require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 50, paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, allowAdvance: true }) }), /lock timeout|canceling statement/)
      } finally { holder.release.resolve() }
      await first; assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 1)
      assert.ok((await receive(second, f)).paymentId)
    })
    await t.test('failure of the existing drawer outbox after recording money rolls back both source and event', async () => {
      const f = await fixture(db)
      await withMocks({ [require.resolve('../src/modules/config/hardware/drawer/events')]: { enqueueDrawerIntent: async () => { throw Error('QA outbox failure') } } }, require.resolve('../src/modules/receivables/domain/receivables'), async api => {
        await assert.rejects(db.$transaction(tx => api.applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 50, paymentMethodId: f.method.id, cashRegisterSessionId: f.session.id, allowAdvance: true, hardware: { scope: {}, origin: 'RECEIVABLE_RECEIPT' } })), /QA outbox failure/)
      })
      assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
      assert.equal((await db.$queryRaw`SELECT id FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`).length, 0)
    })
    await t.test('saved calculation and count are immutable while review status remains writable', async () => {
      const f = await fixture(db), closure = await db.cashClosure.create({ data: { branch_id: f.branch.id, cashier_name: 'QA', date: new Date(), start_date: new Date('2026-10-28'), end_date: new Date(), theoretical_total: 0, theoretical_sales: 0, theoretical_returns: 0, actual_total: 0, difference: 0, difference_percentage: 0, total_transactions: 0, total_customers: 0, average_ticket: 0 } })
      await db.$executeRaw`UPDATE cash_closures SET calculation_snapshot='{"version":1,"basis":"EVENTS_V1","payment_breakdowns":[]}'::jsonb WHERE id=${closure.id}::uuid`
      await assert.rejects(db.$executeRaw`UPDATE cash_closures SET calculation_snapshot='{}'::jsonb WHERE id=${closure.id}::uuid`, /cash_closure_snapshot_immutable/)
      await assert.rejects(db.cashClosure.update({ where: { id: closure.id }, data: { actual_total: 99 } }), /cash_closure_snapshot_immutable/)
      await db.cashClosure.update({ where: { id: closure.id }, data: { status: 'Aprobado' } })
    })
  } finally { await Promise.all([db.$disconnect(), second.$disconnect(), monitor.$disconnect()]) }
})
