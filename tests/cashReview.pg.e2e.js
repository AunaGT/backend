const test = require('node:test'), assert = require('node:assert/strict')
const { qaSchema, fixture, closure, review } = require('./helpers/cashReviewQa.cjs')
const url = process.env.AUNA_CASH_REVIEW_QA_URL
const rejects = (promise, pattern) => assert.rejects(promise, e => pattern.test(String(e.message)), String(pattern))

test('review flow keeps old closures intact and refuses shortcuts even through direct SQL', { skip: !url, timeout: 120000 }, async t => {
  const qa = await qaSchema(url, { migrate: false }), { db } = qa
  try {
    const f = await fixture(db)
    const old = await closure(db, f, { version: 0 })
    const projection = () => db.$queryRaw`SELECT 'closure' AS kind,to_jsonb(c)-'{review_flow_version,supersedes_closure_id,policy_snapshot,review_result,review_classification}'::text[] AS row FROM cash_closures c
      UNION ALL SELECT 'transfer',to_jsonb(x) FROM cash_custody_transfers x UNION ALL SELECT 'session',to_jsonb(s) FROM cash_register_sessions s
      UNION ALL SELECT 'event',to_jsonb(e) FROM cash_money_events e UNION ALL SELECT 'role',to_jsonb(r) FROM roles r ORDER BY kind,row`
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    assert.deepEqual(await db.$queryRaw`SELECT review_flow_version,review_result FROM cash_closures WHERE id=${old}::uuid`, [{ review_flow_version: 0, review_result: null }])

    await t.test('a legacy closure keeps the old approve and reject flow', async () => {
      const legacy = await closure(db, f, { version: 0 })
      await db.$executeRaw`UPDATE cash_closures SET status='Rechazado',supervisor_id=${f.user.id}::uuid WHERE id=${legacy}::uuid`
    })

    await t.test('a v1 closure cannot be rejected or approved without its review record', async () => {
      const id = await closure(db, f)
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Rechazado' WHERE id=${id}::uuid`, /cash_review_state/)
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Aprobado' WHERE id=${id}::uuid`, /cash_review_state/)
      await review(db, f, id, 'FINALIZED', null)
      await db.$executeRaw`UPDATE cash_closures SET status='Aprobado' WHERE id=${id}::uuid`
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Pendiente' WHERE id=${id}::uuid`, /cash_review_state/)
      await rejects(db.$executeRaw`UPDATE cash_closures SET notes='cambio' WHERE id=${id}::uuid`, /cash_review_immutable/)
      await rejects(review(db, f, id, 'DIFFERENCES_ACCEPTED'), /cash_review_state/)
    })

    await t.test('differences beyond policy need an explicit acceptance before finalizing', async () => {
      const id = await closure(db, f, { result: 'REVIEW' })
      await review(db, f, id, 'FINALIZED', null)
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Aprobado' WHERE id=${id}::uuid`, /cash_review_state/)
      await rejects(review(db, f, id, 'DIFFERENCES_ACCEPTED', ' '), /check constraint/)
      await review(db, f, id, 'DIFFERENCES_ACCEPTED', 'Faltante de 5 aceptado')
      await db.$executeRaw`UPDATE cash_closures SET status='Aprobado' WHERE id=${id}::uuid`
    })

    await t.test('reviews are append-only and the flow cannot go back to legacy', async () => {
      const id = await closure(db, f)
      await review(db, f, id, 'RECOUNT_REQUESTED', 'Contar de nuevo')
      await rejects(db.$executeRaw`UPDATE cash_closure_reviews SET reason='x' WHERE cash_closure_id=${id}::uuid`, /cash_review_immutable/)
      await rejects(db.$executeRaw`DELETE FROM cash_closure_reviews WHERE cash_closure_id=${id}::uuid`, /cash_review_immutable/)
      await rejects(db.$executeRaw`UPDATE cash_closures SET review_flow_version=0,policy_snapshot=NULL,review_result=NULL,review_classification=NULL WHERE id=${id}::uuid`, /cash_review_immutable/)
      await rejects(db.$executeRaw`DELETE FROM cash_closures WHERE id=${id}::uuid`, /cash_review_immutable|cash_closure_snapshot_immutable/)
    })

    await t.test('a recount is replaced only by a closure that takes over its turn', async () => {
      const id = await closure(db, f)
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Reconteo' WHERE id=${id}::uuid`, /cash_review_state/)
      await review(db, f, id, 'RECOUNT_REQUESTED', 'Contar de nuevo')
      await db.$executeRaw`UPDATE cash_closures SET status='Reconteo' WHERE id=${id}::uuid`
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Sustituido' WHERE id=${id}::uuid`, /cash_review_state/)
      await rejects(closure(db, f, { supersedes: id }), /cash_review_recount/, 'without the turn link the replacement is refused')
      await db.$transaction(async tx => {
        const next = await closure(tx, f, { supersedes: id })
        await tx.$executeRaw`UPDATE cash_register_sessions SET cash_closure_id=${next}::uuid WHERE id=${f.session.id}::uuid`
        await tx.$executeRaw`UPDATE cash_closures SET status='Sustituido' WHERE id=${id}::uuid`
      })
      await rejects(db.$executeRaw`UPDATE cash_closures SET status='Pendiente' WHERE id=${id}::uuid`, /cash_review_state/)
    })

    await t.test('a transfer cannot be self-received without the company owner exception', async () => {
      const safe = await require('./helpers/cashCustodyQa.cjs').custody(db, f), scope = { ...f.scope, canView: true, canOperateOwn: true, canOperateTeam: false, canReceive: true }
      const { transfer } = await db.$transaction(tx => require('../src/modules/cash-closure/custody').sendTransfer(tx, scope, { requestKey: require('node:crypto').randomUUID(),
        origin: { kind: 'SESSION', sessionId: f.session.id }, destination: { kind: 'CUSTODY', custodyId: safe }, amount: '5.00', reason: 'QA' }))
      await rejects(db.$executeRaw`UPDATE cash_custody_transfers SET status='RECEIVED',receiver_id=sender_id,received_amount=amount WHERE id=${transfer.id}::uuid`, /cash_custody_self_receipt/)
    })

    await t.test('the owner self-review exception only exists company-wide', () => rejects(db.$executeRaw`INSERT INTO cash_difference_policies(company_id,branch_id,owner_self_review,updated_by_id)
      VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,true,${f.user.id}::uuid)`, /check constraint/))
  } finally { await db.$disconnect() }
})

test('review commands classify, finalize once, recount without erasing and refuse self-review', { skip: !url, timeout: 240000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
  try {
    const flow = require('../src/modules/cash-closure/reviewFlow')
    const controller = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/controller'), api => api)
    const reviewer = f => ({ companyId: f.company.id, branchId: f.branch.id, userId: f.other.id, userName: 'Encargado QA', isAdmin: false, canReview: true })
    const self = f => ({ ...reviewer(f), userId: f.user.id })
    const run = fn => db.$transaction(fn, { timeout: 20000 })
    const policy = (f, values) => db.$executeRaw`INSERT INTO cash_difference_policies(company_id,branch_id,cash_threshold,digital_threshold,owner_self_review,updated_by_id)
      VALUES(${f.company.id}::uuid,NULL,${values.cash ?? 0}::numeric,0,${values.owner ?? false},${f.user.id}::uuid)`
    const declare = async (f, delta) => {
      const req = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, name: 'Cajero QA', permissions: ['cashclosure.create_own'] }, query: { cashier_id: f.user.id, cash_register_session_id: f.session.id } }
      const calc = await require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db, req)
      const rows = calc.payment_breakdown.map((m, i) => ({ ...m, actual_amount: (Number(m.theoretical_amount) + (i ? 0 : delta)).toFixed(2), notes: delta && !i ? 'Diferencia contada' : null }))
      const res = jsonResponse(); let error
      await controller.create({ ...req, body: { cashierId: f.user.id, cash_register_session_id: f.session.id, calculationKey: calc.calculation_key,
        actualTotal: rows.reduce((s, r) => s + Number(r.actual_amount), 0).toFixed(2), paymentBreakdowns: rows, denominations: [] } }, res, e => { error = e })
      if (error) throw error
      if (res.statusCode !== 201) throw Object.assign(new Error(JSON.stringify(res.body)), { status: res.statusCode })
      return (await db.$queryRaw`SELECT id,status,review_flow_version,review_result,review_classification,policy_snapshot,supersedes_closure_id,updated_at FROM cash_closures WHERE id=${res.body.id}::uuid`)[0]
    }
    const prepare = async (values = {}) => {
      const f = await fixture(db)
      if (values.cash !== undefined || values.owner) await policy(f, values)
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
      return f
    }
    const finalize = (s, c, extra = {}) => run(tx => flow.finalize(tx, s, c.id, { expectedUpdatedAt: new Date(c.updated_at).toISOString(), ...extra }))
    const recount = (s, c, reason = 'Contar otra vez') => run(tx => flow.requestRecount(tx, s, c.id, { expectedUpdatedAt: new Date(c.updated_at).toISOString(), reason }))

    await t.test('a v1 turn declares into the new flow with its policy frozen and per-method classification', async () => {
      const f = await prepare({ cash: '5.00' }), c = await declare(f, -3)
      assert.equal(c.review_flow_version, 1); assert.equal(c.review_result, 'WITHIN'); assert.equal(c.policy_snapshot.cash_threshold, '5.00')
      assert.deepEqual(c.review_classification.lines.map(l => [l.kind, l.difference, l.status]), [['CASH', '-3.00', 'WITHIN']])
      await db.$executeRaw`UPDATE cash_difference_policies SET cash_threshold=0 WHERE company_id=${f.company.id}::uuid`
      assert.equal((await db.$queryRaw`SELECT policy_snapshot->>'cash_threshold' AS t FROM cash_closures WHERE id=${c.id}::uuid`)[0].t, '5.00', 'later policy changes do not touch it')
      const legacy = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/review'), api => api)
      await assert.rejects(legacy.reviewClosure(db, { user: { sub: f.other.id, permissions: ['cashclosure.approve'] }, companyId: f.company.id, branchId: f.branch.id, params: { id: c.id }, body: { status: 'Rechazado', rejection_reason: 'x', expectedUpdatedAt: new Date(c.updated_at).toISOString() } }), e => e.status === 409 && e.code === 'CASH_REVIEW_FLOW')
    })

    await t.test('the cashier cannot finalize their own count, another reviewer finalizes once', async () => {
      const f = await prepare(), c = await declare(f, 0)
      assert.equal(c.review_result, 'CLEAN')
      await assert.rejects(finalize(self(f), c), e => e.status === 403 && e.code === 'CASH_REVIEW_SELF')
      const done = await finalize(reviewer(f), c)
      assert.equal(done.status, 'Aprobado'); assert.equal(done.reviews.map(r => r.action).join(), 'FINALIZED')
      await assert.rejects(finalize(reviewer(f), c), e => e.status === 409)
      await assert.rejects(recount(reviewer(f), c), e => e.status === 409)
    })

    await t.test('differences beyond tolerance are accepted with a reason in the same action', async () => {
      const f = await prepare(), c = await declare(f, -1)
      assert.equal(c.review_result, 'REVIEW')
      await assert.rejects(finalize(reviewer(f), c), e => e.status === 400 && e.code === 'CASH_REVIEW_REASON')
      const done = await finalize(reviewer(f), c, { reason: 'Faltante de 1 aceptado' })
      assert.deepEqual(done.reviews.map(r => r.action).sort(), ['DIFFERENCES_ACCEPTED', 'FINALIZED'])
    })

    await t.test('concurrent finalize and recount produce one outcome', async () => {
      const f = await prepare(), c = await declare(f, 0)
      const results = await Promise.allSettled([finalize(reviewer(f), c), recount(reviewer(f), c), finalize(reviewer(f), c)])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409), JSON.stringify(results.map(r => r.reason?.message)))
    })

    await t.test('a recount keeps the first declaration and the new one takes over the turn', async () => {
      const f = await prepare(), first = await declare(f, -2)
      const before = await db.$queryRaw`SELECT actual_amount::text,difference::text FROM cash_closure_payments WHERE cash_closure_id=${first.id}::uuid`
      await assert.rejects(recount(reviewer(f), first, ' '), e => e.status === 400)
      assert.equal((await recount(reviewer(f), first)).status, 'Reconteo')
      const sessions = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/sales/cashSessions.controller'), api => api)
      const current = jsonResponse(); let currentError
      await sessions.getCurrent({ companyId: f.company.id, branchId: f.branch.id, branchIds: [f.branch.id], user: { sub: f.user.id, permissions: ['sales.create', 'cashclosure.create_own'] }, query: {} }, current, e => { currentError = e })
      if (currentError) throw currentError
      assert.equal(current.body.closable_session?.id, f.session.id, 'the cashier finds the turn to count again'); assert.equal(current.body.closable_session.recount, true)
      const second = await declare(f, 0)
      assert.equal(second.supersedes_closure_id, first.id); assert.equal(second.review_result, 'CLEAN')
      assert.equal((await db.$queryRaw`SELECT status FROM cash_closures WHERE id=${first.id}::uuid`)[0].status, 'Sustituido')
      assert.deepEqual(await db.$queryRaw`SELECT actual_amount::text,difference::text FROM cash_closure_payments WHERE cash_closure_id=${first.id}::uuid`, before)
      assert.equal((await db.$queryRaw`SELECT cash_closure_id::text AS id FROM cash_register_sessions WHERE id=${f.session.id}::uuid`)[0].id, second.id)
      await assert.rejects(declare(f, 0), e => e.status === 400, 'no third declaration without a new recount')
      assert.equal((await finalize(reviewer(f), second)).status, 'Aprobado')
    })

    await t.test('with the owner exception a self-review is allowed and marked', async () => {
      const f = await prepare({ owner: true }), c = await declare(f, 0)
      const done = await finalize(self(f), c)
      assert.equal(done.status, 'Aprobado'); assert.equal(done.reviews[0].self_review, true)
    })

    await t.test('the owner exception lets the sender receive their own transfer, marked', async () => {
      const f = await fixture(db)
      const safe = await require('./helpers/cashCustodyQa.cjs').custody(db, f)
      const custody = require('../src/modules/cash-closure/custody')
      const own = { ...f.scope, canView: true, canOperateOwn: true, canOperateTeam: false, canReceive: true }
      const { transfer } = await run(tx => custody.sendTransfer(tx, own, { requestKey: require('node:crypto').randomUUID(), origin: { kind: 'SESSION', sessionId: f.session.id }, destination: { kind: 'CUSTODY', custodyId: safe }, amount: '10.00', reason: 'Resguardo' }))
      await assert.rejects(run(tx => custody.receiveTransfer(tx, own, transfer.id, { receivedAmount: '10.00' })), e => e.code === 'CASH_CUSTODY_SAME_PERSON')
      await policy(f, { owner: true })
      const done = await run(tx => custody.receiveTransfer(tx, own, transfer.id, { receivedAmount: '10.00' }))
      assert.equal(done.transfer.status, 'RECEIVED'); assert.equal(done.transfer.self_received, true)
    })
  } finally { await db.$disconnect() }
})

test('blind count hides what is expected from whoever declares until the count is saved', { skip: !url, timeout: 180000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
  try {
    const controller = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/controller'), api => api)
    const http = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/reviewFlow.controller'), api => api)
    const custodyHttp = await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/cash-closure/custody.controller'), api => api)
    const call = async (api, action, req) => { const res = jsonResponse(); res.set = () => res; let error; await api[action](req, res, e => { error = e }); if (error) throw error; return res }
    const f = await fixture(db)
    await db.$executeRaw`INSERT INTO cash_difference_policies(company_id,branch_id,blind_count,updated_by_id) VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,true,${f.user.id}::uuid)`
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
    const cashier = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.user.id, name: 'Cajero', role: { name: 'Cajero' }, permissions: ['cashclosure.create_own', 'cash.transfers.operate_own', 'cashclosure.view'] },
      query: { cashier_id: f.user.id, cash_register_session_id: f.session.id }, params: { sessionId: f.session.id } }
    const calc = (await call(controller, 'calculateTheoretical', cashier)).body
    const text = JSON.stringify(calc)
    assert.equal(calc.blind, true)
    for (const leak of ['theoretical_amount', 'net_total', 'expected_cash_in_drawer', 'opening_float', 'collections', '"theoretical"']) assert.ok(!text.includes(leak), leak)
    assert.ok(calc.payment_breakdown.length > 0 && calc.calculation_key)

    await t.test('the handover screen does not reveal expected cash either', async () => {
      assert.equal((await call(custodyHttp, 'handoverContext', cashier)).body.expectedCash, null)
      const done = await call(custodyHttp, 'handover', { ...cashier, body: { requestKey: require('node:crypto').randomUUID(), deliveredAmount: '0.00', retainedAmount: '1.00' } })
      assert.equal(done.body.handover.expected_cash, null); assert.equal(done.body.handover.difference, null)
      assert.equal((await call(custodyHttp, 'handoverContext', cashier)).body.handover.difference, null)
    })

    let closureId
    await t.test('a blind count with a difference is saved without asking to explain what the cashier cannot see', async () => {
      const rows = calc.payment_breakdown.map(m => ({ ...m, actual_amount: '1.00' }))
      const res = await call(controller, 'create', { ...cashier, body: { cashierId: f.user.id, cash_register_session_id: f.session.id, calculationKey: calc.calculation_key,
        actualTotal: rows.reduce((s, r) => s + Number(r.actual_amount), 0).toFixed(2), paymentBreakdowns: rows, denominations: [] } })
      assert.equal(res.statusCode, 201, JSON.stringify(res.body)); closureId = res.body.id
      assert.ok(res.body.review.review_classification.lines[0].expected, 'after declaring the difference is shown')
    })

    await t.test('the review reads show expected amounts and stay in their scope', async () => {
      const reviewer = { companyId: f.company.id, branchId: f.branch.id, user: { sub: f.other.id, name: 'Encargado', role: { name: 'Encargado' }, permissions: ['cashclosure.approve', 'cashclosure.view'] }, params: { id: closureId, sessionId: f.session.id }, query: {} }
      const body = (await call(http, 'review', reviewer)).body
      assert.equal(body.review_result, 'REVIEW'); assert.equal(body.can.finalize, true); assert.equal(body.history.length, 0)
      assert.equal((await call(http, 'sessionState', reviewer)).body.state, 'PENDING_REVIEW')
      const stranger = await fixture(db)
      await assert.rejects(call(http, 'review', { ...reviewer, companyId: stranger.company.id, branchId: stranger.branch.id, user: { ...reviewer.user, sub: stranger.user.id } }), e => e.status === 404)
      const peer = { ...reviewer, user: { sub: f.other.id, name: 'Otro cajero', role: { name: 'Cajero' }, permissions: ['cashclosure.create_own', 'cashclosure.view'] } }
      await assert.rejects(call(http, 'review', peer), e => e.status === 404, 'another cashier does not read it')
      assert.equal((await call(http, 'review', { ...cashier, params: { id: closureId } })).body.can.finalize, false, 'the declarer reads their own, without actions')
    })
  } finally { await db.$disconnect() }
})
