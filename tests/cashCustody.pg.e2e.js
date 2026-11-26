const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture, custody } = require('./helpers/cashCustodyQa.cjs')
const url = process.env.AUNA_CASH_CUSTODY_QA_URL
const rejects = (promise, pattern) => assert.rejects(promise, e => { if (!pattern.test(String(e.message))) console.error("DIFERENTE:", String(e.message).slice(-300)); return pattern.test(String(e.message)) }, String(pattern))

test('custody tables keep earlier money intact and refuse incoherent money even through direct SQL', { skip: !url, timeout: 120000 }, async t => {
  const qa = await qaSchema(url, { migrate: false }), { db } = qa
  try {
    const f = await fixture(db)
    const projection = () => db.$queryRaw`SELECT 'session' AS kind,to_jsonb(s)-'opening_inherited_amount' AS row FROM cash_register_sessions s
      UNION ALL SELECT 'register',to_jsonb(r) FROM cash_registers r UNION ALL SELECT 'event',to_jsonb(e)-'custody_entry_id' FROM cash_money_events e
      UNION ALL SELECT 'movement',to_jsonb(m) FROM cash_physical_movements m UNION ALL SELECT 'role',to_jsonb(r) FROM roles r ORDER BY kind,row`
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    for (const table of ['cash_custodies', 'cash_turn_handovers', 'cash_custody_transfers', 'cash_custody_entries'])
      assert.equal((await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n, 0, table)
    const safe = await custody(db, f)

    await t.test('money cannot leave a custody without its ledger entry', () => rejects(db.$executeRaw`INSERT INTO cash_custody_transfers(company_id,branch_id,sender_id,request_key,request_hash,origin_kind,origin_custody_id,destination_kind,destination_register_id,amount,currency_code,reason)
      VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${f.user.id}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)},'CUSTODY',${safe}::uuid,'REGISTER',${f.register2.id}::uuid,50,'GTQ','Cambio')`, /cash_custody_transfer_legs/))

    await t.test('an open turn cannot be handed over', () => rejects(db.$executeRaw`INSERT INTO cash_turn_handovers(company_id,branch_id,cash_register_id,cash_register_session_id,actor_id,request_key,request_hash,delivered_amount,retained_amount,currency_code)
      VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,${f.register.id}::uuid,${f.session.id}::uuid,${f.user.id}::uuid,${randomUUID()}::uuid,${'a'.repeat(64)},0,0,'GTQ')`, /cash_custody_handover_turn/))

    await t.test('an inherited opening float must be consumed in the same transaction', async () => {
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
      await rejects(db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,opening_inherited_amount,updated_at,register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version,opening_cash_method_id,opening_cash_method_name)
        VALUES(${randomUUID()}::uuid,${f.register.id}::uuid,${f.user.id}::uuid,100,100,now(),'PHYSICAL','INDIVIDUAL','GTQ','2026-10-30','America/Guatemala',1,${f.method.id},${f.method.name})`, /cash_custody_opening/)
    })

    await t.test('a turn ledger entry cannot exist without its money event', () => rejects(db.$executeRaw`INSERT INTO cash_custody_entries(company_id,branch_id,holder_kind,cash_register_id,cash_register_session_id,direction,amount,currency_code,actor_id,payment_method_id,payment_method_name,leg,opening_session_id)
      VALUES(${f.company.id}::uuid,${f.branch.id}::uuid,'SESSION',${f.register.id}::uuid,${f.session.id}::uuid,'OUT',10,'GTQ',${f.user.id}::uuid,${f.method.id},${f.method.name},'OPENING',${f.session.id}::uuid)`, /check constraint|cash_custody/))
  } finally { await db.$disconnect() }
})

test('custody commands move cash between holders without crediting what did not arrive', { skip: !url, timeout: 180000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const api = require('../src/modules/cash-closure/custody')
    const own = f => ({ ...f.scope, canView: true, canOperateOwn: true, canOperateTeam: false, canReceive: true })
    const receiver = f => ({ ...f.otherScope, canView: true, canReceive: true, canOperateOwn: false, canOperateTeam: false })
    const team = f => ({ ...f.otherScope, canView: true, canReceive: true, canOperateOwn: true, canOperateTeam: true })
    const run = fn => db.$transaction(fn, { timeout: 20000 })
    const send = (f, s, extra = {}) => run(tx => api.sendTransfer(tx, s, { requestKey: randomUUID(), origin: { kind: 'SESSION', sessionId: f.session.id }, destination: { kind: 'CUSTODY', custodyId: f.safe }, amount: '150.00', reason: 'Resguardo en caja fuerte', ...extra }))
    const receive = (s, id, receivedAmount, reason) => run(tx => api.receiveTransfer(tx, s, id, { receivedAmount, ...(reason ? { reason } : {}) }))
    const holderBalance = async (custodyId, registerId = null) => (await db.$queryRaw`SELECT cash_custody_balance(${custodyId}::uuid,${registerId}::uuid)::numeric(14,2)::text AS n`)[0].n
    const events = async sessionId => db.$queryRaw`SELECT direction,amount::text AS amount,source_type FROM cash_money_events WHERE cash_register_session_id=${sessionId}::uuid ORDER BY economic_at,id`
    const prepare = async () => { const f = await fixture(db); f.safe = await custody(db, f); return f }

    await t.test('150 sent and 140 received keeps a visible shortage of 10 and credits only 140', async () => {
      const f = await prepare(), sales = (await db.$queryRaw`SELECT count(*)::int AS n FROM sales`)[0].n
      const { transfer } = await send(f, own(f))
      assert.equal(transfer.status, 'PENDING'); assert.equal(await holderBalance(f.safe), '0.00')
      assert.deepEqual(await events(f.session.id), [{ direction: 'OUT', amount: '150.00', source_type: 'CUSTODY_ENTRY' }])
      await assert.rejects(receive(receiver(f), transfer.id, '140.00'), e => e.code === 'CASH_CUSTODY_DIFFERENCE_REASON')
      const done = await receive(receiver(f), transfer.id, '140.00', 'Faltó un billete de 10')
      assert.equal(done.transfer.status, 'RECEIVED'); assert.equal(done.transfer.difference, '-10.00')
      assert.equal(await holderBalance(f.safe), '140.00', 'never credits the 150 that was sent')
      assert.equal((await receive(receiver(f), transfer.id, '140.00', 'Faltó un billete de 10')).replayed, true, 'a retried receipt is not credited twice')
      assert.equal(await holderBalance(f.safe), '140.00')
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM sales`)[0].n, sales)
    })

    await t.test('the receiver must be someone else and retries replay the same transfer', async () => {
      const f = await prepare(), key = randomUUID()
      const first = await send(f, own(f), { requestKey: key, amount: '20.00' }), again = await send(f, own(f), { requestKey: key, amount: '20.00' })
      assert.equal(again.replayed, true); assert.equal(again.transfer.id, first.transfer.id)
      await assert.rejects(send(f, own(f), { requestKey: key, amount: '25.00' }), e => e.code === 'CASH_CUSTODY_ATTEMPT_CONFLICT')
      await assert.rejects(receive(own(f), first.transfer.id, '20.00'), e => e.code === 'CASH_CUSTODY_SAME_PERSON')
      assert.equal((await events(f.session.id)).length, 1, 'one send, one event')
    })

    await t.test('rejecting sends the money back as a pending return that enters the open turn', async () => {
      const f = await prepare(), { transfer } = await send(f, own(f), { amount: '50.00' })
      const rejected = await run(tx => api.rejectTransfer(tx, receiver(f), transfer.id, { reason: 'No llegó el sobre' }))
      assert.equal(rejected.transfer.status, 'REJECTED'); assert.ok(rejected.transfer.return_transfer_id)
      await assert.rejects(run(tx => api.rejectTransfer(tx, own(f), rejected.transfer.return_transfer_id, { reason: 'x' })), e => e.code === 'CASH_CUSTODY_RETURN_REJECT')
      await receive(own(f), rejected.transfer.return_transfer_id, '50.00')
      assert.deepEqual((await events(f.session.id)).map(e => e.direction + e.amount), ['OUT50.00', 'IN50.00'])
      assert.equal(await holderBalance(f.safe), '0.00')
    })

    await t.test('a receipt after the destination turn closed lands in the retained float, never in the closed turn', async () => {
      const f = await prepare(), first = await send(f, own(f), { amount: '100.00' })
      await receive(receiver(f), first.transfer.id, '100.00')
      const back = await run(tx => api.sendTransfer(tx, team(f), { requestKey: randomUUID(), origin: { kind: 'CUSTODY', custodyId: f.safe }, destination: { kind: 'REGISTER', registerId: f.register.id }, amount: '60.00', reason: 'Cambio para la caja' }))
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
      const before = await events(f.session.id)
      await receive(own(f), back.transfer.id, '60.00')
      assert.deepEqual(await events(f.session.id), before, 'the closed turn is untouched')
      assert.equal(await holderBalance(null, f.register.id), '60.00'); assert.equal(await holderBalance(f.safe), '40.00')
    })

    await t.test('receiving while the destination turn is being closed lands in the retained float instead of failing', async () => {
      const f = await prepare(), first = await send(f, own(f), { amount: '100.00' })
      await receive(receiver(f), first.transfer.id, '100.00')
      const back = await run(tx => api.sendTransfer(tx, team(f), { requestKey: randomUUID(), origin: { kind: 'CUSTODY', custodyId: f.safe }, destination: { kind: 'REGISTER', registerId: f.register.id }, amount: '40.00', reason: 'Cambio' }))
      const before = await events(f.session.id)
      let release; const gate = new Promise(r => { release = r })
      const closing = run(async tx => { await tx.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`; await gate })
      await new Promise(r => setTimeout(r, 200))
      const receiving = receive(own(f), back.transfer.id, '40.00')
      await new Promise(r => setTimeout(r, 300)); release(); await closing
      assert.equal((await receiving).transfer.status, 'RECEIVED')
      assert.deepEqual(await events(f.session.id), before, 'nothing entered the turn that closed meanwhile')
      assert.equal(await holderBalance(null, f.register.id), '40.00')
    })

    await t.test('two sends from a custody cannot overdraw it', async () => {
      const f = await prepare(), first = await send(f, own(f), { amount: '100.00' })
      await receive(receiver(f), first.transfer.id, '100.00')
      const out = () => run(tx => api.sendTransfer(tx, team(f), { requestKey: randomUUID(), origin: { kind: 'CUSTODY', custodyId: f.safe }, destination: { kind: 'REGISTER', registerId: f.register2.id }, amount: '80.00', reason: 'Fondo para otra caja' }))
      const results = await Promise.allSettled([out(), out()])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CASH_CUSTODY_INSUFFICIENT')
      assert.equal(await holderBalance(f.safe), '20.00')
    })

    await t.test('a turn is handed over once and its retained float is inherited once with the counted difference', async () => {
      const f = await prepare()
      const handover = (s, extra = {}) => run(tx => api.handoverTurn(tx, s, f.session.id, { requestKey: randomUUID(), deliveredAmount: '150.00', retainedAmount: '50.00', destinationCustodyId: f.safe, ...extra }))
      await assert.rejects(handover(own(f)), e => e.code === 'CASH_CUSTODY_HANDOVER_TURN')
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
      const done = await handover(own(f))
      assert.equal(done.handover.expected_cash, '200.00'); assert.equal(done.handover.difference, '0.00'); assert.equal(done.handover.transfer_status, 'PENDING')
      await assert.rejects(handover(own(f)), e => e.code === 'CASH_CUSTODY_HANDOVER_DONE')
      await receive(receiver(f), done.handover.transfer_id, '150.00')
      assert.equal(await holderBalance(f.safe), '150.00'); assert.equal(await holderBalance(null, f.register.id), '50.00')
      const open = () => run(async tx => {
        const register = await require('../src/services/cashSessionBoundary').lockScopedRegister(tx, f.scope, f.register.id)
        return require('../src/services/cashEventAdoption').openEventSession(tx, f.scope, register, { openingFloat: '45.00', notes: null })
      })
      const next = await open()
      assert.equal(next.opening_inherited_amount, '50.00'); assert.equal(String(next.opening_float), '45')
      assert.equal(await holderBalance(null, f.register.id), '0.00', 'consumed once')
      assert.deepEqual(await events(next.id), [], 'the inherited float is the opening, not an income')
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${next.id}::uuid`
      assert.equal((await open()).opening_inherited_amount, null, 'nothing left to inherit')
    })

    await t.test('retaining a float is refused once the register already opened another turn', async () => {
      const f = await prepare(), closedId = randomUUID()
      await db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,status,closed_at,updated_at,register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version)
        VALUES(${closedId}::uuid,${f.register.id}::uuid,${f.user.id}::uuid,0,'CLOSED',now(),now(),'PHYSICAL','INDIVIDUAL','GTQ','2026-10-29','America/Guatemala',1)`
      await assert.rejects(run(tx => api.handoverTurn(tx, own(f), closedId, { requestKey: randomUUID(), deliveredAmount: '0.00', retainedAmount: '10.00' })), e => e.code === 'CASH_CUSTODY_FLOAT_OPEN_TURN')
    })
  } finally { await db.$disconnect() }
})

test('custody reads stay in their branch and explain what is pending', { skip: !url, timeout: 120000 }, async () => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const api = require('../src/modules/cash-closure/custody'), run = fn => db.$transaction(fn, { timeout: 20000 })
    const f = await fixture(db), stranger = await fixture(db)
    const own = { ...f.scope, canView: true, canOperateOwn: true, canManage: true, canReceive: false }, receiver = { ...f.otherScope, canView: true, canReceive: true }
    const safe = (await run(tx => api.createCustody(tx, own, { name: 'Caja fuerte' }))).id
    await assert.rejects(run(tx => api.createCustody(tx, own, { name: ' caja FUERTE ' })), e => e.code === 'CASH_CUSTODY_NAME')
    const { transfer } = await run(tx => api.sendTransfer(tx, own, { requestKey: randomUUID(), origin: { kind: 'SESSION', sessionId: f.session.id }, destination: { kind: 'CUSTODY', custodyId: safe }, amount: '30.00', reason: 'Resguardo' }))
    await assert.rejects(api.getTransfer(db, { ...stranger.scope, canView: true }, transfer.id), e => e.status === 404, 'another company sees nothing')
    const toReceive = await api.listTransfers(db, receiver, { direction: 'to_receive' })
    assert.equal(toReceive.totalItems, 1); assert.equal(toReceive.summary.toReceive, 1)
    assert.equal((await api.listTransfers(db, own, { direction: 'to_receive' })).totalItems, 0, 'the sender does not receive their own transfer')
    await run(tx => api.receiveTransfer(tx, receiver, transfer.id, { receivedAmount: '25.00', reason: 'Faltaron 5' }))
    assert.equal((await api.listTransfers(db, own, {})).summary.shortage, '5.00')
    await assert.rejects(run(tx => api.setCustodyActive(tx, own, safe, { active: false })), e => e.code === 'CASH_CUSTODY_BALANCE')
    await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
    assert.deepEqual((await api.pendingHandovers(db, own)).map(s => s.id), [f.session.id])
    const context = await api.handoverContext(db, own, f.session.id)
    assert.equal(context.expectedCash, '170.00'); assert.equal(context.canHandover, true); assert.deepEqual(context.custodies.map(c => c.name), ['Caja fuerte'])
    assert.deepEqual((await api.pendingHandovers(db, { ...stranger.scope, canOperateOwn: true })), [], 'no turns from other companies')
  } finally { await db.$disconnect() }
})
