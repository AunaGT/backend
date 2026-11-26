const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture } = require('./helpers/cashDailyQa.cjs')
const url = process.env.AUNA_CASH_DAILY_QA_URL
const rejects = (promise, pattern) => assert.rejects(promise, e => { const ok = pattern.test(String(e.message)); if (!ok) console.error('DIFERENTE:', String(e.message).slice(-300)); return ok }, String(pattern))

test('daily consolidations keep history intact, refuse open turns and are immutable even through direct SQL', { skip: !url, timeout: 240000 }, async t => {
  const qa = await qaSchema(url, { migrate: false }), { db } = qa
  try {
    const f = await fixture(db)
    const projection = () => db.$queryRaw`SELECT 'session' AS kind,to_jsonb(s) AS row FROM cash_register_sessions s UNION ALL SELECT 'closure',to_jsonb(c) FROM cash_closures c
      UNION ALL SELECT 'event',to_jsonb(e) FROM cash_money_events e UNION ALL SELECT 'entry',to_jsonb(j) FROM journal_entries j ORDER BY kind,row`
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    const [{ business_date: day }] = await db.$queryRaw`SELECT business_date::text FROM cash_register_sessions WHERE id=${f.period.id}::uuid`
    const insert = (date = day) => db.$executeRaw`INSERT INTO cash_daily_consolidations(company_id,branch_id,business_date,content_hash,snapshot,finalized_by_id)
      VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${date}::date,${'a'.repeat(64)},'{}'::jsonb,${f.user.id}::uuid)`

    await t.test('a day with an open turn cannot be consolidated', () => rejects(insert(), /cash_day_open_turn/))

    await t.test('a closed turn without a finalized count still blocks', async () => {
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE cash_register_id IN(SELECT id FROM cash_registers WHERE branch_id=${f.branch.id}::uuid) AND status='OPEN'`
      await rejects(insert(), /cash_day_pending/)
    })

    await t.test('a consolidation is unique per day and immutable', async () => {
      await insert('2026-01-02')
      await rejects(insert('2026-01-02'), /already exists|23505/)
      await rejects(db.$executeRaw`UPDATE cash_daily_consolidations SET content_hash=${'b'.repeat(64)} WHERE business_date='2026-01-02'`, /cash_day_immutable/)
      await rejects(db.$executeRaw`DELETE FROM cash_daily_consolidations WHERE business_date='2026-01-02'`, /cash_day_immutable/)
    })

    await t.test('client roles have no access to 4B or daily tables', async () => {
      await db.$executeRaw`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$`
      const schema = qa.schema
      qa.sql(`GRANT SELECT ON cash_settlements TO authenticated; ` + require('node:fs').readFileSync(require('node:path').join(__dirname, '../prisma/migrations/20261104100000_cash_daily_consolidation/migration.sql'), 'utf8').split('-- Fin defensa')[0].split('\n').filter(l => !l.startsWith('-- Defensa:')).join('\n').split('-- Defensa').pop().replace(/^[\s\S]*?(?=DO \$\$ DECLARE client_role)/, ''))
      const [{ ok }] = await db.$queryRaw`SELECT has_table_privilege('authenticated', ${schema + '.cash_settlements'}, 'SELECT') AS ok`
      assert.equal(ok, false)
    })
  } finally { await db.$disconnect() }
})

test('the day view summarizes turns, cash and digital pending, and finalizing freezes it without touching money', { skip: !url, timeout: 400000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
  try {
    const api = require('../src/modules/cash-closure/dailyConsolidation'), run = fn => db.$transaction(fn, { timeout: 30000 })
    const adoption = require('../src/services/cashEventAdoption'), boundary = require('../src/services/cashSessionBoundary')
    const controller = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/controller'), m => m)
    const f = await fixture(db), staff = { ...f.scope, canFinalize: true, canView: true }, reviewer = { ...f.scope, userId: f.other.id, userName: 'Encargada', canReview: true }
    const methods = require('../src/modules/cash-closure/bankMethods')
    await db.companyModule.create({ data: { company_id: f.company.id, module_code: 'accounting', status: 'DISABLED' } })
    const { version } = await run(tx => methods.proposeBankMethod(tx, { ...f.scope, canManage: true }, { paymentMethodId: f.card.id, mode: 'DEFERRED', destinationLabel: 'Visanet' }))
    await run(tx => methods.approveBankMethod(tx, { ...f.scope, isAdmin: true }, version.id))
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.period.id}::uuid`
    // El período virtual de la fixture cerró sin arqueo: se arquea al final igual que el resto.
    const physical = await run(async tx => adoption.openEventSession(tx, f.scope, await boundary.lockScopedRegister(tx, f.scope, f.register.id), { openingFloat: '100.00', notes: null }))
    const virtual = await run(async tx => adoption.openEventSession(tx, f.scope, await boundary.lockScopedRegister(tx, f.scope, f.virtual.id), { openingFloat: '0.00', notes: null }))
    const [{ business_date: day }] = await db.$queryRaw`SELECT business_date::text FROM cash_register_sessions WHERE id=${physical.id}::uuid`
    const pay = (sessionId, methodId, amount) => run(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount, paymentMethodId: methodId, cashRegisterSessionId: sessionId, allowAdvance: true }))
    await pay(physical.id, f.method.id, 50)
    await run(tx => require('../src/modules/cash-closure/physicalMovements').createPhysicalMovement(tx, { ...f.scope, canCreateOwn: true, canCreateTeam: false }, { requestKey: randomUUID(), cashRegisterSessionId: physical.id, direction: 'OUT', amount: '10.00', paymentMethodId: f.method.id, counterpartyLabel: 'Tienda', reason: 'Compra de agua' }))
    await pay(virtual.id, f.card.id, 75)
    await run(tx => require('../src/modules/cash-closure/notices').createNotice(tx, { ...f.scope, canCreate: true }, { requestKey: randomUUID(), customerId: f.customer.id, amount: '20.00', paymentMethodId: f.bank.id, reportedPaidOn: day }))
    const close = id => db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${id}::uuid`
    const declare = async (sessionId, delta) => {
      const req = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, name: 'Cajero QA', permissions: ['cashclosure.create_own'] }, query: { cashier_id: f.user.id, cash_register_session_id: sessionId } }
      const calc = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, req)
      const rows = calc.payment_breakdown.map(m => ({ ...m, actual_amount: (Number(m.theoretical_amount) + (m.settlement_kind === 'CASH' ? delta : 0)).toFixed(2), notes: delta && m.settlement_kind === 'CASH' ? 'Faltó una moneda' : null }))
      const res = jsonResponse(); let error
      await controller.create({ ...req, body: { cashierId: f.user.id, cash_register_session_id: sessionId, calculationKey: calc.calculation_key, actualTotal: rows.reduce((s, r) => s + Number(r.actual_amount), 0).toFixed(2), paymentBreakdowns: rows, denominations: [] } }, res, e => { error = e })
      if (error) throw error
      if (res.statusCode !== 201) throw new Error(JSON.stringify(res.body))
      return (await db.$queryRaw`SELECT id,updated_at,review_result FROM cash_closures WHERE id=${res.body.id}::uuid`)[0]
    }
    const finalizeClosure = c => run(tx => require('../src/modules/cash-closure/reviewFlow').finalize(tx, reviewer, c.id, { expectedUpdatedAt: new Date(c.updated_at).toISOString(), reason: 'Faltante de una moneda aceptado' }))

    await t.test('an operating turn blocks and says so', async () => {
      const view = await api.dayView(db, staff, day)
      assert.equal(view.status, 'PROVISIONAL'); assert.ok(view.snapshot.blockers.some(b => b.code === 'OPERATING'))
      assert.equal(view.snapshot.turns.find(turn=>turn.id===physical.id).responsible_id,f.user.id)
      await assert.rejects(run(tx => api.finalizeDay(tx, staff, day, { contentKey: view.contentKey })), e => e.status === 409 && e.code === 'CASH_DAY_BLOCKED')
    })

    const safe = await require('./helpers/cashCustodyQa.cjs').custody(db, f)
    await close(physical.id); await close(virtual.id)
    await run(tx => require('../src/modules/cash-closure/custody').handoverTurn(tx, { ...f.scope, canView: true, canOperateOwn: true, canOperateTeam: false, canReceive: true }, physical.id, { requestKey: randomUUID(), deliveredAmount: '100.00', retainedAmount: '40.00', destinationCustodyId: safe }))

    await t.test('a closed turn without its count and a count pending review block', async () => {
      assert.ok((await api.dayView(db, staff, day)).snapshot.blockers.some(b => b.code === 'PENDING_COUNT'))
      const c = await declare(physical.id, -1)
      assert.ok((await api.dayView(db, staff, day)).snapshot.blockers.some(b => b.code === 'PENDING_REVIEW'))
      await finalizeClosure(c)
      await finalizeClosure(await declare(virtual.id, 0))
      await finalizeClosure(await declare(f.period.id, 0))
    })

    let view
    await t.test('a finished day adds up from its documents and digital pending does not block', async () => {
      view = await api.dayView(db, staff, day)
      const snapshot=view.snapshot
      assert.deepEqual(snapshot.blockers, [])
      assert.equal(snapshot.turns.length, 3); assert.ok(snapshot.turns.every(turn => turn.state === 'FINALIZED'))
      assert.equal(snapshot.cash.opening, '100.00'); assert.equal(snapshot.cash.received, '50.00'); assert.equal(snapshot.cash.paidOut, '10.00')
      assert.equal(snapshot.cash.delivered, '100.00'); assert.equal(snapshot.cash.retained, '40.00'); assert.equal(snapshot.cash.acceptedDifference, '-1.00')
      assert.deepEqual(snapshot.digital.byMethod.map(m => [m.name, m.amount]), [['Tarjeta QA', '75.00']])
      assert.equal(snapshot.digital.toSettle, '75.00'); assert.equal(view.current.pendingNotices.count, 1); assert.equal(view.current.pendingNotices.amount, '20.00');assert.equal(snapshot.digital.pendingNotices,undefined)
      assert.ok(snapshot.legacyNotice === null || typeof snapshot.legacyNotice === 'string')
    })

    await t.test('a stale view cannot finalize, and finalizing changes no money or entry', async () => {
      await assert.rejects(run(tx => api.finalizeDay(tx, staff, day, { contentKey: 'f'.repeat(64) })), e => e.status === 409 && e.code === 'CASH_DAY_CHANGED')
      const money = () => db.$queryRaw`SELECT 'payment' AS k,to_jsonb(p) AS r FROM customer_payments p UNION ALL SELECT 'event',to_jsonb(e) FROM cash_money_events e UNION ALL SELECT 'closure',to_jsonb(c) FROM cash_closures c UNION ALL SELECT 'entry',to_jsonb(j) FROM journal_entries j ORDER BY k,r`
      const before = await money()
      const [a, b] = await Promise.allSettled([run(tx => api.finalizeDay(tx, staff, day, { contentKey: view.contentKey })), run(tx => api.finalizeDay(tx, staff, day, { contentKey: view.contentKey }))])
      assert.equal(a.status, 'fulfilled'); assert.equal(b.status, 'fulfilled', b.reason?.message)
      assert.equal(a.value.view.status, 'FINALIZED'); assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_daily_consolidations WHERE branch_id=${f.branch.id}::uuid`)[0].n, 1)
      assert.deepEqual(await money(), before)
    })

    await t.test('a finalized day reads from its snapshot even when something arrives later', async () => {
      await run(tx => require('../src/modules/cash-closure/notices').createNotice(tx, { ...f.scope, canCreate: true }, { requestKey: randomUUID(), customerId: f.customer.id, amount: '30.00', paymentMethodId: f.bank.id, reportedPaidOn: day }))
      const after = await api.dayView(db, staff, day)
      assert.equal(after.status, 'FINALIZED'); assert.equal(after.contentKey, view.contentKey); assert.equal(after.snapshot.digital.toSettle, '75.00');assert.equal(after.current.pendingNotices.count,2)
    })

    await t.test('a night turn counts only on the day it opened', async () => {
      const night = randomUUID()
      await db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version,opened_at)
        VALUES(${night}::uuid,${f.register2.id}::uuid,${f.user.id}::uuid,0,now(),'PHYSICAL','INDIVIDUAL','GTQ','2026-01-05','America/Guatemala',1,'2026-01-05T23:00:00-06:00')`
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at='2026-01-06T05:00:00-06:00' WHERE id=${night}::uuid`
      assert.deepEqual((await api.dayView(db, staff, '2026-01-05')).snapshot.turns.map(x => x.id), [night])
      assert.deepEqual((await api.dayView(db, staff, '2026-01-06')).snapshot.turns, [])
    })

    await t.test('another branch sees nothing of this day', async () => {
      const other = await db.branch.create({ data: { company_id: f.company.id, name: 'Otra', code: 'OTR' } })
      const elsewhere = await api.dayView(db, { ...staff, branchId: other.id }, day)
      assert.equal(elsewhere.status, 'PROVISIONAL'); assert.deepEqual(elsewhere.snapshot.turns, [])
    })
  } finally { await db.$disconnect() }
})
