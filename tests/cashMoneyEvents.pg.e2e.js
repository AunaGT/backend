const test = require('node:test'), assert = require('node:assert/strict')
const { qaSchema, fixture } = require('./helpers/cashMoneyEventsQa.cjs')
const { recordMoneyEvent } = require('../src/modules/cash-closure/events')
const qaUrl = process.env.AUNA_CASH_EVENTS_QA_URL
test('additive cash ledger preserves legacy and enforces canonical atomic sources in real PostgreSQL', { skip: !qaUrl, timeout: 90000 }, async t => {
  const qa = await qaSchema(qaUrl, { migrate: false }), db = qa.db
  try {
    const legacy = await fixture(db, 0)
    await legacy.receipt(db)
    const permission = await db.permission.create({ data: { code: 'cashclosure.create_own', name: 'Presentar arqueo propio' } })
    await db.rolePermission.create({ data: { role_id: legacy.user.role_id, permission_id: permission.id } })
    await db.userBranch.create({ data: { user_id: legacy.user.id, branch_id: legacy.branch.id } })
    const supplier = await db.supplier.create({ data: { company_id: legacy.company.id, name: 'Legacy supplier QA', contact: 'QA', party_type: 'SUPPLIER' } })
    const closure = { id: require('node:crypto').randomUUID() }
    await db.$executeRaw`INSERT INTO supplier_payments(id,company_id,branch_id,supplier_id,amount,currency_code,paid_at,registered_by,payment_method_id,request_key,request_hash)
      VALUES(${require('node:crypto').randomUUID()}::uuid,${legacy.company.id}::uuid,${legacy.branch.id}::uuid,${supplier.id}::uuid,25,'GTQ','2026-10-28T12:00:00Z',${legacy.user.id}::uuid,${legacy.method.id},${require('node:crypto').randomUUID()}::uuid,${'a'.repeat(64)})`
    await db.$executeRaw`INSERT INTO cash_closures(id,branch_id,start_date,end_date,cashier_name,cashier_id,opening_float,theoretical_total,theoretical_sales,theoretical_returns,actual_total,difference,total_transactions,total_customers,average_ticket,updated_at)
      VALUES(${closure.id}::uuid,${legacy.branch.id}::uuid,'2026-10-28T08:00:00Z','2026-10-28T18:00:00Z','Legacy QA',${legacy.user.id}::uuid,200,250,0,0,250,0,0,0,0,now())`
    await db.cashClosurePayment.create({ data: { cash_closure_id: closure.id, payment_method_id: legacy.method.id, theoretical_amount: 250, theoretical_count: 1, actual_amount: 250, difference: 0 } })
    await db.cashClosureDenomination.create({ data: { cash_closure_id: closure.id, type: 'Billete', denomination: 50, quantity: 5, subtotal: 250 } })
    const projection = () => db.$queryRaw`SELECT 'register' AS kind,to_jsonb(r)-'money_event_version' AS row FROM cash_registers r
      UNION ALL SELECT 'session',to_jsonb(s)-ARRAY['money_event_version','business_timezone','opening_cash_method_id','opening_cash_method_name'] FROM cash_register_sessions s
      UNION ALL SELECT 'receipt',to_jsonb(p)-ARRAY['request_key','request_hash'] FROM customer_payments p
      UNION ALL SELECT 'supplier_payment',to_jsonb(p)-'cash_register_session_id' FROM supplier_payments p
      UNION ALL SELECT 'closure',to_jsonb(c)-'calculation_snapshot' FROM cash_closures c
      UNION ALL SELECT 'closure_payment',to_jsonb(p) FROM cash_closure_payments p
      UNION ALL SELECT 'denomination',to_jsonb(d) FROM cash_closure_denominations d
      UNION ALL SELECT 'role',to_jsonb(r) FROM roles r
      UNION ALL SELECT 'permission',to_jsonb(p) FROM permissions p
      UNION ALL SELECT 'grant',to_jsonb(g) FROM role_permissions g
      UNION ALL SELECT 'assignment',to_jsonb(a) FROM user_branches a
      UNION ALL SELECT 'user',to_jsonb(u) FROM users u ORDER BY kind,row`
    const before = await projection(); qa.apply(); assert.deepEqual(await projection(), before)
    const [{ version }] = await db.$queryRaw`SELECT money_event_version AS version FROM cash_register_sessions WHERE id=${legacy.session.id}::uuid`
    assert.equal(version, 0); assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_money_events`)[0].n, 0)
    await legacy.receipt(db)
    await t.test('a source and its event commit once and replay uses the frozen method after closing', async () => {
      const f = await fixture(db)
      let payment, original
      await db.$transaction(async tx => { const session = await f.locked(tx); payment = await f.receipt(tx)
        original = await recordMoneyEvent(tx, f.scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: payment.id }) })
      await db.paymentMethod.update({ where: { id: f.method.id }, data: { name: 'Renamed', settlement_kind: 'BANK' } })
      await db.cashRegisterSession.update({ where: { id: f.session.id }, data: { status: 'CLOSED', closed_at: new Date() } })
      const replay = await db.$transaction(async tx => recordMoneyEvent(tx, f.scope, { session: await f.locked(tx), sourceType: 'CUSTOMER_PAYMENT', sourceId: payment.id }))
      assert.equal(replay.id, original.id); assert.equal(replay.replayed, true)
      const rows = await db.$queryRaw`SELECT amount,settlement_kind,payment_method_name FROM cash_money_events WHERE source_id=${payment.id}::uuid`
      assert.equal(rows.length, 1); assert.equal(rows[0].amount.toFixed(2), '50.00'); assert.equal(rows[0].settlement_kind, 'CASH'); assert.equal(rows[0].payment_method_name, 'Efectivo QA')
      await assert.rejects(db.$executeRaw`UPDATE cash_money_events SET amount=1 WHERE source_id=${payment.id}::uuid`, /cash_event_immutable/)
      await assert.rejects(db.$executeRaw`DELETE FROM cash_money_events WHERE source_id=${payment.id}::uuid`, /cash_event_immutable/)
      await assert.rejects(db.customerPayment.delete({ where: { id: payment.id } }))
    })
    await t.test('an old writer without an event fails at commit and leaves no receipt', async () => {
      const f = await fixture(db)
      await assert.rejects(db.$transaction(async tx => { await f.locked(tx); await f.receipt(tx) }), /cash_event_required/)
      assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
    })
    await t.test('editing a source amount cannot rewrite its event and rolls back the edit', async () => {
      const f = await fixture(db); let payment
      await db.$transaction(async tx => { const session = await f.locked(tx); payment = await f.receipt(tx)
        await recordMoneyEvent(tx, f.scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: payment.id }) })
      await assert.rejects(db.customerPayment.update({ where: { id: payment.id }, data: { amount: 51 } }), /cash_event_source_immutable/)
      assert.equal((await db.customerPayment.findUnique({ where: { id: payment.id } })).amount.toFixed(2), '50.00')
    })
    await t.test('another scope or mismatched company currency cannot record or leave money', async () => {
      const f = await fixture(db), other = await fixture(db)
      for (const scope of [other.scope, { ...f.scope, userId: other.user.id }]) {
        await assert.rejects(db.$transaction(async tx => { const session = await f.locked(tx), receipt = await f.receipt(tx)
          await recordMoneyEvent(tx, scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: receipt.id }) }), e => e.status === 404)
      }
      await db.systemSetting.update({ where: { company_id_key: { company_id: f.company.id, key: 'currency_code' } }, data: { value: 'USD' } })
      await assert.rejects(db.$transaction(async tx => { const session = await f.locked(tx), receipt = await f.receipt(tx)
        await recordMoneyEvent(tx, f.scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: receipt.id }) }), e => e.code === 'CASH_EVENT_CURRENCY')
      assert.equal(await db.customerPayment.count({ where: { branch_id: f.branch.id } }), 0)
    })
    await t.test('a new ledger turn cannot downgrade or lose its frozen timezone', async () => {
      const f = await fixture(db)
      await assert.rejects(db.$executeRaw`UPDATE cash_register_sessions SET money_event_version=0 WHERE id=${f.session.id}::uuid`, /cash_event_session/)
      await assert.rejects(db.$executeRaw`UPDATE cash_register_sessions SET business_timezone='UTC' WHERE id=${f.session.id}::uuid`, /cash_event_session/)
      await assert.rejects(db.$executeRaw`UPDATE cash_registers SET money_event_version=0 WHERE id=${f.register.id}::uuid`, /cash_event_register/)
    })
    await t.test('a wrong origin FK is rejected by the source check, not accepted as SQL NULL', async () => {
      const f = await fixture(db)
      await assert.rejects(db.$transaction(async tx => {
        const session = await f.locked(tx), first = await f.receipt(tx)
        await recordMoneyEvent(tx, f.scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: first.id })
        const second = await f.receipt(tx)
        await tx.$executeRaw`INSERT INTO cash_money_events (id,company_id,branch_id,cash_register_id,cash_register_session_id,
          source_type,source_id,direction,amount,payment_method_id,payment_method_name,settlement_kind,currency_code,actor_id,economic_at,content_hash,sale_id)
          SELECT gen_random_uuid(),company_id,branch_id,cash_register_id,cash_register_session_id,source_type,${second.id}::uuid,
          direction,amount,payment_method_id,payment_method_name,settlement_kind,currency_code,actor_id,economic_at,content_hash,gen_random_uuid()
          FROM cash_money_events WHERE customer_payment_id=${first.id}::uuid`
      }), e => e.meta?.code === '23514' && /single_source/.test(e.meta?.message || ''))
    })
    await t.test('an incomplete request hash cannot pass a nullable SQL check', async () => {
      await assert.rejects(db.$transaction(async tx => {
        const receipt = await legacy.receipt(tx)
        await tx.$executeRaw`UPDATE customer_payments SET request_key=gen_random_uuid(),request_hash=NULL WHERE id=${receipt.id}::uuid`
      }), e => e.meta?.code === '23514')
    })
    await t.test('database rejects NaN money even when a broken writer constructs a matching source', async () => {
      const f = await fixture(db)
      await assert.rejects(db.$transaction(async tx => {
        const session = await f.locked(tx), first = await f.receipt(tx)
        await recordMoneyEvent(tx, f.scope, { session, sourceType: 'CUSTOMER_PAYMENT', sourceId: first.id })
        const bad = await f.receipt(tx)
        await tx.$executeRaw`UPDATE customer_payments SET amount='NaN'::numeric WHERE id=${bad.id}::uuid`
        await tx.$executeRaw`INSERT INTO cash_money_events (id,company_id,branch_id,cash_register_id,cash_register_session_id,
          source_type,source_id,direction,amount,payment_method_id,payment_method_name,settlement_kind,currency_code,actor_id,economic_at,content_hash,customer_payment_id)
          SELECT gen_random_uuid(),company_id,branch_id,cash_register_id,cash_register_session_id,source_type,${bad.id}::uuid,
          direction,'NaN'::numeric,payment_method_id,payment_method_name,settlement_kind,currency_code,actor_id,economic_at,content_hash,${bad.id}::uuid
          FROM cash_money_events WHERE customer_payment_id=${first.id}::uuid`
      }), e => e.meta?.code === '23514')
    })
    await t.test('a newly inserted ledger register requires its physical individual currency identity', async () => {
      const f = await fixture(db)
      await assert.rejects(db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,updated_at,money_event_version)
        VALUES(gen_random_uuid(),${f.branch.id}::uuid,'Invalid','BAD',now(),1)`, e => e.meta?.code === '23514')
    })
  } finally { await db.$disconnect() }
})
