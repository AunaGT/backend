const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture } = require('./helpers/cashNoticesQa.cjs')
const url = process.env.AUNA_CASH_VIRTUAL_QA_URL

test('a virtual register opens digital periods without cash and its count shows only bank methods', { skip: !url, timeout: 180000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const f = await fixture(db)
    const run = fn => db.$transaction(fn, { timeout: 20000 })
    await assert.rejects(f.open('10.00'), e => e.status === 409, 'a virtual period has no opening float')
    const period = await f.open()
    const [s] = await db.$queryRaw`SELECT register_type,opening_float::text AS float,opening_cash_method_id,money_event_version FROM cash_register_sessions WHERE id=${period.id}::uuid`
    assert.deepEqual(s, { register_type: 'VIRTUAL', float: '0.00', opening_cash_method_id: null, money_event_version: 1 })
    const pay = methodId => run(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount: 75, paymentMethodId: methodId, cashRegisterSessionId: period.id, allowAdvance: true }))

    await t.test('a bank payment records its BANK event and cash is refused', async () => {
      assert.ok((await pay(f.bank.id)).paymentId)
      await assert.rejects(pay(f.method.id), e => e.code === 'CASH_VIRTUAL_METHOD')
      assert.deepEqual(await db.$queryRaw`SELECT settlement_kind,amount::text AS amount FROM cash_money_events WHERE cash_register_session_id=${period.id}::uuid`, [{ settlement_kind: 'BANK', amount: '75.00' }])
    })

    await t.test('physical movements and custody transfers never use a virtual period', async () => {
      const movements = require('../src/modules/cash-closure/physicalMovements')
      await assert.rejects(run(tx => movements.createPhysicalMovement(tx, { ...f.scope, canCreateOwn: true, canCreateTeam: false }, { requestKey: randomUUID(), cashRegisterSessionId: period.id, direction: 'IN', amount: '5.00', paymentMethodId: f.method.id, counterpartyLabel: 'QA', reason: 'Fondo' })), e => e.status === 409)
      const safe = await require('./helpers/cashCustodyQa.cjs').custody(db, f)
      await assert.rejects(run(tx => require('../src/modules/cash-closure/custody').sendTransfer(tx, { ...f.scope, canView: true, canOperateOwn: true, canOperateTeam: false, canReceive: true },
        { requestKey: randomUUID(), origin: { kind: 'SESSION', sessionId: period.id }, destination: { kind: 'CUSTODY', custodyId: safe }, amount: '5.00', reason: 'QA' })), e => e.status === 409)
    })

    await t.test('the period count lists only bank methods, without cash expected', async () => {
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${period.id}::uuid`
      const calc = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, { companyId: f.company.id, branchId: f.branch.id,
        user: { sub: f.user.id, permissions: ['cashclosure.create_own'] }, query: { cashier_id: f.user.id, cash_register_session_id: period.id } })
      assert.deepEqual(calc.payment_breakdown.map(m => [m.settlement_kind, m.theoretical_amount]), [['BANK', 75]])
      assert.equal(calc.cash_session.expected_cash_in_drawer, 0)
      await assert.rejects(run(tx => require('../src/modules/cash-closure/custody').handoverTurn(tx, { ...f.scope, canView: true, canOperateOwn: true, canOperateTeam: false, canReceive: true }, period.id,
        { requestKey: randomUUID(), deliveredAmount: '0.00', retainedAmount: '0.00' })), e => e.status === 409, 'a virtual period has no cash handover')
    })
  } finally { await db.$disconnect() }
})

test('payment notices keep history intact and refuse unbacked confirmations even through direct SQL', { skip: !url, timeout: 180000 }, async t => {
  const qa = await qaSchema(url, { migrate: false }), { db } = qa
  const rejects = (promise, pattern) => assert.rejects(promise, e => pattern.test(String(e.message)), String(pattern))
  try {
    const projection = () => db.$queryRaw`SELECT 'register' AS kind,to_jsonb(r) AS row FROM cash_registers r UNION ALL SELECT 'session',to_jsonb(s) FROM cash_register_sessions s
      UNION ALL SELECT 'payment',to_jsonb(p) FROM customer_payments p UNION ALL SELECT 'event',to_jsonb(e) FROM cash_money_events e UNION ALL SELECT 'closure',to_jsonb(c) FROM cash_closures c ORDER BY kind,row`
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_payment_notices`)[0].n, 0)
    const f = await fixture(db), period = await f.open()
    const notice = async (extra = {}) => {
      const id = randomUUID()
      await db.$executeRaw`INSERT INTO cash_payment_notices(id,company_id,branch_id,customer_id,amount,currency_code,payment_method_id,reported_paid_on,reported_reference,created_by_id,request_key,request_hash)
        VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${f.customer.id}::uuid,${extra.amount ?? 75}::numeric,'GTQ',${extra.method ?? f.bank.id},'2026-11-01','DEP-1',${f.user.id}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)})`
      return id
    }
    const confirm = (id, paymentId, extra = {}) => db.$executeRaw`UPDATE cash_payment_notices SET status='CONFIRMED',customer_payment_id=${paymentId}::uuid,confirmed_by_id=${f.other.id}::uuid,paid_on='2026-11-01',
      external_reference='BANCO-123',verification_id=${'verification' in extra ? extra.verification : 'AUT-99'},evidence_path=${extra.path ?? null},attested=true,cash_register_session_id=${extra.session ?? period.id}::uuid WHERE id=${id}::uuid`
    const pay = (amount = 75, sessionId = period.id) => db.$transaction(tx => require('../src/modules/receivables').applyPayment(tx, { ...f.scope, customerId: f.customer.id, amount, paymentMethodId: f.bank.id, cashRegisterSessionId: sessionId, allowAdvance: true }))

    await t.test('a notice is born pending, for a bank method of the company', async () => {
      await rejects(notice({ method: f.method.id }), /cash_notice_method/)
      await rejects(db.$executeRaw`INSERT INTO cash_payment_notices(company_id,branch_id,customer_id,amount,currency_code,payment_method_id,reported_paid_on,created_by_id,request_key,request_hash,status)
        VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${f.customer.id}::uuid,10,'GTQ',${f.bank.id},'2026-11-01',${f.user.id}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)},'CONFIRMED')`, /cash_notice_state|check constraint/)
    })

    await t.test('confirming needs the identical payment in an open virtual period and evidence', async () => {
      const id = await notice()
      await rejects(confirm(id, randomUUID()), /cash_notice_payment|foreign key/)
      await rejects(confirm(id, (await pay(70)).paymentId), /cash_notice_payment/)
      const good = (await pay()).paymentId
      await rejects(confirm(id, good, { verification: null }), /check constraint/)
      await rejects(confirm(id, good, { verification: null, path: `${randomUUID()}/notices/x.pdf` }), /check constraint/)
      await confirm(id, good)
      await rejects(db.$executeRaw`UPDATE cash_payment_notices SET status='REJECTED',rejected_by_id=${f.other.id}::uuid,rejection_reason='x' WHERE id=${id}::uuid`, /cash_notice_state/)
      await rejects(db.$executeRaw`UPDATE cash_payment_notices SET notes='cambio' WHERE id=${id}::uuid`, /cash_notice_state/)
      await rejects(db.$executeRaw`DELETE FROM cash_payment_notices WHERE id=${id}::uuid`, /cash_notice_state/)
    })

    await t.test('a physical turn never receives a confirmed notice', async () => {
      const id = await notice()
      const physical = (await db.$queryRaw`SELECT id FROM cash_register_sessions WHERE cash_register_id=${f.register.id}::uuid AND status='OPEN'`)[0]
      const cardOnPhysical = (await pay(75, physical.id)).paymentId
      await rejects(confirm(id, cardOnPhysical, { session: physical.id }), /cash_notice_payment/)
    })

    await t.test('a rejection keeps the notice with its reason and no money', async () => {
      const id = await notice()
      await rejects(db.$executeRaw`UPDATE cash_payment_notices SET status='REJECTED',rejected_by_id=${f.other.id}::uuid,rejection_reason=' ' WHERE id=${id}::uuid`, /check constraint/)
      await db.$executeRaw`UPDATE cash_payment_notices SET status='REJECTED',rejected_by_id=${f.other.id}::uuid,rejection_reason='No aparece en el banco' WHERE id=${id}::uuid`
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM customer_payments WHERE customer_id=${f.customer.id}::uuid`)[0].n, 3)
    })
  } finally { await db.$disconnect() }
})

test('notice commands confirm once into a virtual period and leave pending notices without money', { skip: !url, timeout: 240000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const api = require('../src/modules/cash-closure/notices')
    const run = fn => db.$transaction(fn, { timeout: 20000 })
    const staff = f => ({ ...f.scope, canCreate: true, canConfirm: true, canView: true })
    const prepare = async () => { const f = await fixture(db); f.period = await f.open(); return f }
    const create = (f, extra = {}) => run(tx => api.createNotice(tx, staff(f), { requestKey: randomUUID(), customerId: f.customer.id, amount: '75.00', paymentMethodId: f.bank.id, reportedPaidOn: '2026-11-01', reportedReference: 'Depósito 123', ...extra }))
    const confirm = (f, id, extra = {}) => run(tx => api.confirmNotice(tx, staff(f), id, { sessionId: f.period.id, paidOn: '2026-11-01', externalReference: 'BI-778899', verificationId: 'AUT-55', attested: true, allowAdvance: true, ...extra }))
    const money = async f => ({
      payments: (await db.$queryRaw`SELECT count(*)::int AS n FROM customer_payments WHERE customer_id=${f.customer.id}::uuid`)[0].n,
      events: (await db.$queryRaw`SELECT count(*)::int AS n FROM cash_money_events WHERE company_id=${f.company.id}::uuid`)[0].n,
      entries: (await db.$queryRaw`SELECT count(*)::int AS n FROM journal_entries WHERE company_id=${f.company.id}::uuid`)[0].n })

    await t.test('a pending notice changes no balance, event or entry, and a retry replays it', async () => {
      const f = await prepare(), before = await money(f), key = randomUUID()
      const first = await create(f, { requestKey: key })
      assert.equal(first.notice.status, 'PENDING'); assert.deepEqual(await money(f), before)
      const again = await create(f, { requestKey: key })
      assert.equal(again.replayed, true); assert.equal(again.notice.id, first.notice.id)
      await assert.rejects(create(f, { requestKey: key, amount: '80.00' }), e => e.status === 409)
      await assert.rejects(create(f, { paymentMethodId: f.method.id }), e => e.status === 409 || e.status === 400, 'cash is not a digital notice')
    })

    await t.test('confirming creates one payment and one BANK event in the virtual period; retries replay', async () => {
      const f = await prepare(), { notice } = await create(f)
      const done = await confirm(f, notice.id)
      assert.equal(done.notice.status, 'CONFIRMED'); assert.ok(done.notice.customer_payment_id); assert.equal(done.notice.confirmed_by_name, 'Cashier QA')
      assert.deepEqual(await db.$queryRaw`SELECT settlement_kind,amount::text AS amount,source_type FROM cash_money_events WHERE cash_register_session_id=${f.period.id}::uuid`, [{ settlement_kind: 'BANK', amount: '75.00', source_type: 'CUSTOMER_PAYMENT' }])
      const again = await confirm(f, notice.id)
      assert.equal(again.replayed, true); assert.equal(again.notice.customer_payment_id, done.notice.customer_payment_id)
      await assert.rejects(confirm(f, notice.id, { externalReference: 'OTRA' }), e => e.status === 409)
      await assert.rejects(run(tx => api.rejectNotice(tx, staff(f), notice.id, { reason: 'Tarde' })), e => e.status === 409)
    })

    await t.test('two concurrent confirmations produce a single payment', async () => {
      const f = await prepare(), { notice } = await create(f)
      const results = await Promise.allSettled([confirm(f, notice.id), confirm(f, notice.id), run(tx => api.rejectNotice(tx, staff(f), notice.id, { reason: 'Duplicado' }))])
      assert.ok(results.some(r => r.status === 'fulfilled'))
      assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409), JSON.stringify(results.map(r => r.reason?.message)))
      const [{ n }] = await db.$queryRaw`SELECT count(*)::int AS n FROM customer_payments WHERE customer_id=${f.customer.id}::uuid`
      assert.ok(n <= 1)
    })

    await t.test('a physical turn, a closed period or another person period is refused without effects', async () => {
      const f = await prepare(), { notice } = await create(f), before = await money(f)
      await assert.rejects(confirm(f, notice.id, { sessionId: f.session.id }), e => e.status === 409 && e.code === 'CASH_NOTICE_PERIOD')
      await assert.rejects(run(tx => api.confirmNotice(tx, { ...staff(f), userId: f.other.id }, notice.id, { sessionId: f.period.id, paidOn: '2026-11-01', externalReference: 'BI-1', verificationId: 'A', attested: true, allowAdvance: true })), e => e.status === 403)
      await assert.rejects(confirm(f, notice.id, { attested: false }), e => e.status === 400)
      await assert.rejects(confirm(f, notice.id, { verificationId: null }), e => e.status === 400, 'evidence is required')
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.period.id}::uuid`
      await assert.rejects(confirm(f, notice.id), e => e.status === 409)
      assert.deepEqual(await money(f), before)
      assert.equal((await run(tx => api.rejectNotice(tx, staff(f), notice.id, { reason: 'No aparece en el banco' }))).notice.status, 'REJECTED')
    })

    await t.test('notices stay inside their company and the list shows the queue', async () => {
      const f = await prepare(), stranger = await fixture(db), { notice } = await create(f)
      await assert.rejects(run(tx => api.getNotice(tx, staff(stranger), notice.id)), e => e.status === 404)
      const page = await api.listNotices(db, staff(f), { status: 'PENDING', page: 1, pageSize: 20 })
      assert.equal(page.items[0].id, notice.id); assert.equal(page.items[0].customer_name, 'Customer QA'); assert.equal(page.summary.pending, 1)
    })
  } finally { await db.$disconnect() }
})
