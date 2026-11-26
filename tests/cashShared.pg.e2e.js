const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), fs = require('node:fs'), path = require('node:path')
const { qaSchema, fixture } = require('./helpers/cashDailyQa.cjs')
const url = process.env.AUNA_CASH_DAILY_QA_URL
test('shared configuration preserves history and requires a ledger, explicit access and two people', { skip: !url, timeout: 120000 }, async () => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const f = await fixture(db)
    const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`
    const projection = async () => Promise.all(tables.map(async ({tablename}) => ({ table:tablename, rows:await db.$queryRawUnsafe(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM "${tablename.replaceAll('"','""')}" t`) })))
    const allBefore = await projection()
    const before = await db.$queryRaw`SELECT to_jsonb(s) AS row FROM cash_register_sessions s ORDER BY id`
    qa.sql(fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261119100000_cash_shared_turns/migration.sql'), 'utf8'))
    assert.deepEqual(await projection(),allBefore,'all existing tables including roles, permissions, money and closures stay identical')
    const config = require('../src/modules/sales/cashRegisters.configuration')
    const [r] = await db.$queryRaw`SELECT * FROM cash_registers WHERE id=${f.register2.id}::uuid`
    await db.$transaction(tx => config.saveRegisterConfiguration(tx, f.scope, { id: r.id, requestKey: randomUUID(), expectedRevision: r.revision, name: r.name, operationMode: 'SHARED', enableExplicitAccess: true, authorizedUserIds: [f.user.id, f.other.id] }))
    assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(s) AS row FROM cash_register_sessions s ORDER BY id`, before)
    await assert.rejects(db.$executeRaw`UPDATE cash_registers SET operation_mode='SHARED' WHERE id=${f.register.id}::uuid`)
    await assert.rejects(db.$executeRaw`UPDATE cash_registers SET operation_mode='SHARED' WHERE id=${f.virtual.id}::uuid`)
    const [saved] = await db.$queryRaw`SELECT * FROM cash_registers WHERE id=${r.id}::uuid`
    assert.equal(saved.operation_mode, 'SHARED')
    assert.equal(saved.access_control_version, 1)
  } finally { await db.$disconnect() }
})
test('joined participants operate under their own identity; revocation and closing prevent further money', { skip: !url, timeout: 120000 }, async () => {
  const { qaSchema, fixture } = require('./helpers/cashSharedQa.cjs'), qa = await qaSchema(url), { db } = qa
  try {
    const f = await fixture(db), turn = await f.open(), shared = require('../src/services/cashSharedSessions')
    const movement = require('../src/modules/cash-closure/physicalMovements')
    const input = () => ({ requestKey: randomUUID(), cashRegisterSessionId: turn.id, direction: 'IN', amount: '10.25', paymentMethodId: f.method.id, reason: 'Aporte real', counterpartyLabel: 'Caja fuerte' })
    const operate = scope => db.$transaction(tx => movement.createPhysicalMovement(tx, { ...scope, canCreateOwn: true }, input()))
    await assert.rejects(operate(f.otherScope), e => e.status === 403)
    await db.$transaction(tx => shared.join(tx, f.otherScope, turn.id))
    await db.$transaction(tx => shared.join(tx, f.otherScope, turn.id))
    await operate(f.scope); await operate(f.otherScope)
    const events = await db.$queryRaw`SELECT actor_id,amount::text AS amount FROM cash_money_events WHERE cash_register_session_id=${turn.id}::uuid ORDER BY actor_id`
    assert.deepEqual(events.map(e => e.actor_id).sort(), [f.user.id,f.other.id].sort())
    assert.ok(events.every(e => e.amount === '10.25'))
    await assert.rejects(db.$executeRaw`UPDATE cash_registers SET operation_mode='INDIVIDUAL' WHERE id=${f.register2.id}::uuid`, /cash_register_mode_open/)
    const safe = await require('./helpers/cashCustodyQa.cjs').custody(db,f)
    await db.$transaction(tx => require('../src/modules/cash-closure/custody').sendTransfer(tx,{...f.otherScope,canOperateOwn:true},{requestKey:randomUUID(),origin:{kind:'SESSION',sessionId:turn.id},destination:{kind:'CUSTODY',custodyId:safe},amount:'5.00',reason:'Entrega parcial'}))
    await db.$executeRaw`UPDATE cash_register_access SET active=false WHERE register_id=${f.register2.id}::uuid AND user_id=${f.other.id}::uuid`
    await assert.rejects(operate(f.otherScope), e => e.status === 403)
    assert.equal((await shared.participants(db, turn.id)).length, 2)
    await assert.rejects(db.$executeRaw`DELETE FROM cash_session_participants WHERE session_id=${turn.id}::uuid`, /cash_participant_immutable/)
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now(),closed_by_id=${f.user.id}::uuid WHERE id=${turn.id}::uuid`
    await assert.rejects(operate(f.scope), e => e.status === 409)
    const handover = {requestKey:randomUUID(),deliveredAmount:'0.00',retainedAmount:'15.50'}
    await assert.rejects(db.$transaction(tx=>require('../src/modules/cash-closure/custody').handoverTurn(tx,{...f.otherScope,canOperateOwn:true},turn.id,handover)), e=>e.status===403)
    await db.$transaction(tx=>require('../src/modules/cash-closure/custody').handoverTurn(tx,{...f.scope,canOperateOwn:true},turn.id,handover))
  } finally { await db.$disconnect() }
})
test('a historical participant cannot review a shared closure; owner exception is recorded', { skip: !url, timeout: 120000 }, async () => {
  const qa = await require('./helpers/cashSharedQa.cjs').qaSchema(url), { db } = qa
  try {
    const f = await require('./helpers/cashSharedQa.cjs').fixture(db), turn = await f.open()
    await db.$transaction(tx => require('../src/services/cashSharedSessions').join(tx, f.otherScope, turn.id))
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now(),closed_by_id=${f.user.id}::uuid WHERE id=${turn.id}::uuid`
    const id = await require('./helpers/cashReviewQa.cjs').closure(db, f)
    await db.$executeRaw`UPDATE cash_register_sessions SET cash_closure_id=${id}::uuid WHERE id=${turn.id}::uuid`
    const [c] = await db.$queryRaw`SELECT updated_at FROM cash_closures WHERE id=${id}::uuid`
    const scope = { ...f.otherScope, canReview:true }
    const flow = require('../src/modules/cash-closure/reviewFlow')
    await assert.rejects(db.$transaction(tx => flow.finalize(tx, scope, id, { expectedUpdatedAt:c.updated_at.toISOString() })), e => e.code === 'CASH_REVIEW_SELF')
    await db.$executeRaw`INSERT INTO cash_difference_policies(company_id,owner_self_review,updated_by_id) VALUES(${f.company.id}::uuid,true,${f.user.id}::uuid)`
    await db.$transaction(tx => flow.finalize(tx, scope, id, { expectedUpdatedAt:c.updated_at.toISOString() }))
    assert.equal((await db.$queryRaw`SELECT self_review FROM cash_closure_reviews WHERE cash_closure_id=${id}::uuid AND action='FINALIZED'`)[0].self_review, true)
  } finally { await db.$disconnect() }
})
test('concurrent HTTP opening joins a single shared turn and participants cannot close it', { skip: !url, timeout: 120000 }, async () => {
  const qa = await require('./helpers/cashSharedQa.cjs').qaSchema(url), { db } = qa
  const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
  try {
    const f = await require('./helpers/cashSharedQa.cjs').fixture(db)
    await withMocks({ [require.resolve('../src/models/prisma')]: { prisma: db } }, require.resolve('../src/modules/sales/cashSessions.controller'), async api => {
      const req = scope => ({ companyId:scope.companyId,branchId:scope.branchId,user:{sub:scope.userId,role:{name:'Cashier QA'},permissions:['sales.create']},query:{},body:{cash_register_id:f.register2.id,opening_float:'0.00'} })
      const call = async (action, request) => { const res=jsonResponse();res.set=()=>res;let error;await api[action](request,res,e=>error=e);if(error)throw error;return res }
      const [a,b] = await Promise.all([call('openSession',req(f.scope)), call('openSession',req(f.otherScope))])
      assert.equal(a.statusCode,201);assert.equal(b.statusCode,201);assert.equal(a.body.id,b.body.id)
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_session_participants WHERE session_id=${a.body.id}::uuid`)[0].n,2)
      const actor = a.body.opened_by_id === f.user.id ? f.otherScope : f.scope
      assert.equal((await call('closeSession',req(actor))).statusCode,403)
      const declare = { ...req(actor), query:{cashier_id:actor.userId,cash_register_session_id:a.body.id} }
      await assert.rejects(require('../src/modules/cash-closure/theoretical').calculateTheoreticalData(db,declare),e=>e.status===403)
    })
  } finally { await db.$disconnect() }
})
test('my turns exposes all pending work, joined role and actions without expected amounts', { skip: !url, timeout: 120000 }, async () => {
  const qa = await require('./helpers/cashSharedQa.cjs').qaSchema(url), { db } = qa
  try {
    const f = await require('./helpers/cashSharedQa.cjs').fixture(db), turn=await f.open()
    await db.$transaction(tx=>require('../src/services/cashSharedSessions').join(tx,f.otherScope,turn.id))
    const api=require('../src/modules/cash-closure/myTurns')
    const view=await api.myTurns(db,{...f.otherScope,canOperate:true,canDeclare:true})
    assert.equal(view.current[0].role,'PARTICIPANT');assert.equal(view.current[0].can.close,false)
    assert.equal(JSON.stringify(view).includes('opening_float'),false)
    assert.equal(JSON.stringify(view).includes('expected'),false)
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now(),closed_by_id=${f.user.id}::uuid WHERE id=${turn.id}::uuid OR id=${f.session.id}::uuid`
    const owner=await api.myTurns(db,{...f.scope,canDeclare:true,canHandoverOwn:true})
    assert.ok(owner.pending.some(p=>p.id===turn.id));assert.ok(owner.pending.some(p=>p.id===f.session.id))
    const newer=await f.open()
    const {withMocks,jsonResponse}=require('./helpers/reportHarness.cjs')
    await withMocks({[require.resolve('../src/models/prisma')]:{prisma:db}},require.resolve('../src/modules/sales/cashSessions.controller'),async api=>{
      const res=jsonResponse();res.set=()=>res;let error
      await api.getCurrent({companyId:f.company.id,branchId:f.branch.id,user:{sub:f.user.id,permissions:['cashclosure.create_own']},query:{cash_register_session_id:turn.id}},res,e=>error=e)
      if(error)throw error
      assert.equal(res.body.session,null);assert.equal(res.body.closable_session.id,turn.id);assert.notEqual(res.body.closable_session.id,newer.id)
    })
    await assert.rejects(api.myTurns(db,{...f.scope,branchId:randomUUID()},turn.id),e=>e.status===404)
  } finally { await db.$disconnect() }
})
