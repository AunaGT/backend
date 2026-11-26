const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { qaSchema, fixture, insertMovement, insertEvent } = require('./helpers/cashPhysicalMovementsQa.cjs')
const url = process.env.AUNA_CASH_MOVEMENTS_QA_URL
test('physical movements protect the old ledger and require their canonical event atomically', { skip: !url, timeout: 120000 }, async t => {
  const qa = await qaSchema(url, { migrate: false }), { db } = qa
  try {
    const f = await fixture(db)
    const projection = () => db.$queryRaw`SELECT 'register' AS kind,to_jsonb(r) AS row FROM cash_registers r
      UNION ALL SELECT 'session',to_jsonb(s) FROM cash_register_sessions s UNION ALL SELECT 'user',to_jsonb(u) FROM users u
      UNION ALL SELECT 'role',to_jsonb(r) FROM roles r UNION ALL SELECT 'event',to_jsonb(e)-'physical_movement_id' FROM cash_money_events e ORDER BY kind,row`
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_physical_movements`)[0].n, 0)
    await t.test('source without event is rolled back and a complete pair is immutable', async () => {
      await assert.rejects(db.$transaction(tx => insertMovement(tx, f)), /cash_physical_event_required/)
      const m = await db.$transaction(async tx => { const row = await insertMovement(tx, f); await insertEvent(tx, row); return row })
      await assert.rejects(db.$executeRaw`UPDATE cash_physical_movements SET reason='Otra' WHERE id=${m.id}::uuid`, /cash_physical_immutable/)
      await assert.rejects(db.$executeRaw`DELETE FROM cash_physical_movements WHERE id=${m.id}::uuid`, /cash_physical_immutable/)
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_physical_movements`)[0].n, 1)
    })
    await t.test('foreign scope, fake money/method and late inserts fail before committing', async () => {
      const other = await fixture(db), legacy = await fixture(db, 0)
      for (const changes of [{ company_id: other.company.id }, { branch_id: other.branch.id }, { currency_code: 'USD' }, { payment_method_id: other.method.id }, { payment_method_name: 'Inventado' }, { direction: 'OUT', amount: '999.00' }, { amount: '0.00' }]) {
        await assert.rejects(db.$transaction(async tx => { const m = await insertMovement(tx, f, changes); await insertEvent(tx, m) }))
      }
      await assert.rejects(db.$transaction(async tx => { const m = await insertMovement(tx, legacy); await insertEvent(tx, m) }), /cash_physical_turn/)
      const closed = await fixture(db); await db.cashRegisterSession.update({ where: { id: closed.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      await assert.rejects(db.$transaction(async tx => { const m = await insertMovement(tx, closed); await insertEvent(tx, m) }), /cash_physical_turn/)
      await db.paymentMethod.update({ where: { id: other.method.id }, data: { settlement_kind: 'BANK' } })
      await assert.rejects(db.$transaction(async tx => { const m = await insertMovement(tx, other); await insertEvent(tx, m) }), /cash_physical_method/)
    })
    await t.test('compensation is unique, opposite and cannot cross identities or compensate itself', async () => {
      const m = await db.$transaction(async tx => { const row = await insertMovement(tx, f); await insertEvent(tx, row); return row })
      for (const changes of [{ direction: 'IN' }, { direction: 'OUT', amount: '9.00' }]) await assert.rejects(db.$transaction(async tx => { const row = await insertMovement(tx, f, { corrects_movement_id: m.id, ...changes }); await insertEvent(tx, row) }), /cash_physical_correction/)
      const corrected = await db.$transaction(async tx => { const row = await insertMovement(tx, f, { corrects_movement_id: m.id, direction: 'OUT' }); await insertEvent(tx, row); return row })
      await assert.rejects(db.$transaction(async tx => { const row = await insertMovement(tx, f, { corrects_movement_id: m.id, direction: 'OUT' }); await insertEvent(tx, row) }))
      await assert.rejects(db.$transaction(async tx => { const row = await insertMovement(tx, f, { corrects_movement_id: corrected.id }); await insertEvent(tx, row) }), /cash_physical_correction/)
      const other = await fixture(db)
      await assert.rejects(db.$transaction(async tx => { const row = await insertMovement(tx, other, { corrects_movement_id: m.id, direction: 'OUT' }); await insertEvent(tx, row) }), /cash_physical_correction/)
    })
  } finally { await db.$disconnect() }
})
test('physical commands serialize cash, compensate with current custody and recover their saved result', { skip: !url, timeout: 120000 }, async t => {
  const qa = await qaSchema(url), { db } = qa
  try {
    const api = require('../src/modules/cash-closure/physicalMovements')
    const scope = f => ({ ...f.scope, canViewOwn: true, canCreateOwn: true, canViewTeam: false, canCreateTeam: false, canCorrect: true })
    const input = (f, extra = {}) => ({ requestKey: randomUUID(), cashRegisterSessionId: f.session.id, direction: 'OUT', amount: '20.00', paymentMethodId: f.method.id, reason: 'Resguardo físico', counterpartyLabel: 'Encargado', ...extra })
    const save = (f, command, s = scope(f)) => db.$transaction(tx => api.createPhysicalMovement(tx, s, command), { timeout: 20000 })
    await t.test('one idempotent receipt survives a closed turn and disabled payment method', async () => {
      const f = await fixture(db), command = input(f)
      const [a,b] = await Promise.all([save(f, command), save(f, command)])
      assert.equal(a.id,b.id); assert.equal([a,b].filter(r => r.replayed).length,1); assert.equal(a.movement.amount,'20.00')
      await assert.rejects(save(f,{ ...command,amount:'21.00' }),e=>e.status===409)
      await db.cashRegisterSession.update({ where:{id:f.session.id},data:{status:'CLOSED',closed_at:new Date()} })
      await db.companyPaymentMethod.update({ where:{company_id_payment_method_id:{company_id:f.company.id,payment_method_id:f.method.id}},data:{enabled:false} })
      assert.equal((await save(f,command)).id,a.id)
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`)[0].n,1)
    })
    await t.test('two withdrawals cannot both spend the same remainder', async () => {
      const f = await fixture(db)
      const results = await Promise.allSettled([save(f,input(f,{amount:'150.00'})),save(f,input(f,{amount:'150.00'}))])
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
      assert.equal(results.find(r=>r.status==='rejected').reason.code,'CASH_PHYSICAL_INSUFFICIENT')
    })
    await t.test('an existing customer receipt still uses the audited commercial source projection',async()=>{
      const f=await fixture(db)
      await db.$transaction(async tx=>{const session=await f.locked(tx),paid=await f.receipt(tx);await require('../src/modules/cash-closure/events').recordMoneyEvent(tx,f.scope,{session,sourceType:'CUSTOMER_PAYMENT',sourceId:paid.id})})
      assert.equal((await db.$queryRaw`SELECT amount::text,source_type FROM cash_money_events WHERE cash_register_session_id=${f.session.id}::uuid`)[0].source_type,'CUSTOMER_PAYMENT')
    })
    await t.test('ending the turn concurrently never permits a late money event',async()=>{
      const f=await fixture(db)
      const [movement]=await Promise.allSettled([save(f,input(f)),db.$transaction(async tx=>{await f.locked(tx);await tx.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=clock_timestamp() WHERE id=${f.session.id}::uuid`})])
      const [check]=await db.$queryRaw`SELECT s.status,count(e.id)::int AS events,bool_and(e.recorded_at<=s.closed_at) AS before_cut FROM cash_register_sessions s LEFT JOIN cash_money_events e ON e.cash_register_session_id=s.id WHERE s.id=${f.session.id}::uuid GROUP BY s.id`
      assert.equal(check.status,'CLOSED');assert.equal(check.events,movement.status==='fulfilled'?1:0);if(check.events)assert.equal(check.before_cut,true)
      await assert.rejects(save(f,input(f)),e=>e.code==='CASH_SESSION_CLOSED')
    })
    await t.test('current actor membership is locked and revoked membership cannot record new money',async()=>{
      const f=await fixture(db)
      let release,held;const heldPromise=new Promise(r=>held=r),releasePromise=new Promise(r=>release=r)
      const removal=db.$transaction(async tx=>{await tx.userCompany.update({where:{user_id_company_id:{user_id:f.user.id,company_id:f.company.id}},data:{status:'INACTIVE'}});const [pid]=await tx.$queryRaw`SELECT pg_backend_pid()::int AS id`;held(pid.id);await releasePromise},{timeout:20000})
      const holder=await heldPromise;let attempted
      const started=new Promise(r=>attempted=r)
      const pending=db.$transaction(async tx=>{const [pid]=await tx.$queryRaw`SELECT pg_backend_pid()::int AS id`;attempted(pid.id);return api.createPhysicalMovement(tx,scope(f),input(f))},{timeout:20000});pending.catch(()=>{})
      const waiter=await started
      try{let blocked=false;const end=Date.now()+5000;while(Date.now()<end){const [row]=await db.$queryRaw`SELECT ${holder}::int=ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;if(row.blocked){blocked=true;break}await new Promise(setImmediate)}assert.equal(blocked,true)}finally{release()}
      await removal;await assert.rejects(pending,e=>e.code==='CASH_MOVEMENT_MEMBERSHIP')
    })
    await t.test('delegated physical authority preserves its real actor without granting other money operations', async () => {
      const f = await fixture(db), supervisor = await db.user.create({data:{name:'Encargado QA',email:randomUUID()+'@example.invalid',password:'qa',role_id:f.user.role_id}})
      await db.userCompany.create({data:{company_id:f.company.id,user_id:supervisor.id,role_id:f.user.role_id}})
      await db.userBranch.create({data:{branch_id:f.branch.id,user_id:supervisor.id}})
      const own = {...scope(f),userId:supervisor.id}
      await assert.rejects(save(f,input(f),own),e=>e.status===403)
      const receipt = await save(f,input(f),{...own,canCreateTeam:true})
      assert.equal(receipt.movement.actor_id,supervisor.id)
      const boundary=require('../src/services/cashSessionBoundary')
      await assert.rejects(db.$transaction(async tx=>boundary.assertSessionOperation(await boundary.lockScopedSession(tx,own,f.session.id),own,{settlementKind:'CASH'})),e=>e.code==='CASH_SESSION_OTHER_USER')
    })
    await t.test('compensation of a closed original belongs only to the current turn and is unique', async () => {
      const f=await fixture(db), original=await save(f,input(f))
      await db.cashRegisterSession.update({where:{id:f.session.id},data:{status:'CLOSED',closed_at:new Date()}})
      const old=await db.$queryRaw`SELECT to_jsonb(e) AS row FROM cash_money_events e WHERE cash_register_session_id=${f.session.id}::uuid ORDER BY id`
      const session=await db.$transaction(async tx=>require('../src/services/cashEventAdoption').openEventSession(tx,scope(f),await require('../src/services/cashSessionBoundary').lockScopedRegister(tx,scope(f),f.register.id),{openingFloat:'100.00',notes:null}))
      const commands=[0,1].map(()=>({requestKey:randomUUID(),cashRegisterSessionId:session.id,reason:'Efectivo físicamente devuelto'}))
      const results=await Promise.allSettled(commands.map(command=>db.$transaction(tx=>api.correctPhysicalMovement(tx,scope(f),original.id,command),{timeout:20000})))
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
      const saved=results.find(r=>r.status==='fulfilled').value
      assert.equal(saved.movement.direction,'IN');assert.equal(saved.movement.amount,'20.00');assert.equal(saved.movement.corrects_movement_id,original.id)
      assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(e) AS row FROM cash_money_events e WHERE cash_register_session_id=${f.session.id}::uuid ORDER BY id`,old)
      await assert.rejects(db.$transaction(tx=>api.correctPhysicalMovement(tx,scope(f),saved.id,{...commands[0],requestKey:randomUUID()})),e=>e.status===409)
    })
    await t.test('foreign queries do not return a record or the team directory',async()=>{
      const f=await fixture(db),other=await fixture(db),saved=await save(f,input(f))
      await assert.rejects(api.getPhysicalMovement(db,scope(other),saved.id),e=>e.status===404)
      await assert.rejects(api.listPhysicalMovements(db,scope(f),{view:'team'}),e=>e.status===403)
      const page=await api.listPhysicalMovements(db,scope(f),{view:'own',page:1,pageSize:20})
      assert.equal(page.totalItems,1);assert.equal(page.items[0].id,saved.id)
      assert.deepEqual(page.summary,{inAmount:saved.movement.direction==='IN'?saved.movement.amount:'0.00',outAmount:saved.movement.direction==='OUT'?saved.movement.amount:'0.00'},'totals cover the whole filter, not only the visible page')
    })
  }finally{await db.$disconnect()}
})
