const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
const base = require('./helpers/cashMoneyEventsQa.cjs')
const url = process.env.AUNA_CASH_ROLLOUT_QA_URL
const migration = name => fs.readFileSync(path.join(__dirname, '../prisma/migrations', name, 'migration.sql'), 'utf8')

// Ensayo de despliegue: historia previa a 2B.2, luego 2B.2 → 5 en orden, como en la base activa.
test('the whole cash plan applies in order over legacy history, keeps it intact and stays compatible with older writers', { skip: !url, timeout: 400000 }, async t => {
  const qa = await base.qaSchema(url, { migrate: false, qaDatabase: 'auna_cash_rollout_qa' }), { db, sql } = qa
  try {
    const legacy = await base.fixture(db, 0)
    await legacy.receipt(db); await legacy.receipt(db)
    const closureId = randomUUID()
    await db.$executeRaw`INSERT INTO cash_closures(id,branch_id,start_date,end_date,cashier_name,cashier_id,opening_float,theoretical_total,theoretical_sales,theoretical_returns,actual_total,difference,total_transactions,total_customers,average_ticket,updated_at,status)
      VALUES(${closureId}::uuid,${legacy.branch.id}::uuid,'2026-10-20T08:00:00Z','2026-10-20T18:00:00Z','Legacy QA',${legacy.user.id}::uuid,200,300,100,0,295,-5,2,1,50,now(),'Aprobado')`
    const projection = () => db.$queryRaw`SELECT 'session' AS k,jsonb_build_object('id',id,'status',status,'opening_float',opening_float,'closure',cash_closure_id) AS r FROM cash_register_sessions
      UNION ALL SELECT 'closure',jsonb_build_object('id',id,'status',status,'actual',actual_total,'difference',difference,'notes',notes) FROM cash_closures
      UNION ALL SELECT 'payment',jsonb_build_object('id',id,'amount',amount,'method',payment_method_id,'session',cash_register_session_id) FROM customer_payments
      UNION ALL SELECT 'register',jsonb_build_object('id',id,'name',name,'code',code,'kind',kind) FROM cash_registers ORDER BY k,r`
    const columns = () => db.$queryRaw`SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema=${qa.schema}`
    const before = await projection(), tablesBefore = new Set((await columns()).map(c => c.table_name)), colsBefore = new Set((await columns()).map(c => c.table_name + '.' + c.column_name))
    const steps = [
      ['2B.2 libro de eventos', () => qa.apply()],
      ['3A acceso a cajas', () => sql('DROP TABLE IF EXISTS cash_register_commands; DROP TABLE IF EXISTS cash_register_access; ALTER TABLE cash_registers DROP COLUMN IF EXISTS access_control_version;\nBEGIN;\n' + migration('20261029150000_cash_register_access') + '\nCOMMIT;')],
      ['3B.1 movimientos físicos', () => sql('BEGIN;\n' + migration('20261030100000_cash_physical_movements') + '\nCOMMIT;')],
      ['3B.2 custodia y entrega', () => sql('BEGIN;\nALTER TABLE cash_register_sessions DROP COLUMN opening_inherited_amount;\n' + migration('20261031100000_cash_custody') + '\nCOMMIT;')],
      ['3C revisión', () => sql('BEGIN;\n' + migration('20261101100000_cash_review') + '\nCOMMIT;')],
      ['4A avisos y cajas virtuales', () => sql('BEGIN;\n' + migration('20261102100000_cash_payment_notices') + '\nCOMMIT;')],
      ['4B medios y liquidaciones', () => sql('BEGIN;\n' + migration('20261103100000_cash_bank_settlements') + '\nCOMMIT;')],
      ['5 cierre del día', () => sql('BEGIN;\n' + migration('20261104100000_cash_daily_consolidation') + '\nCOMMIT;')],
    ]
    for (const [label, apply] of steps) { apply(); assert.deepEqual(await projection(), before, `history changed after ${label}`) }
    const oldDay=randomUUID()
    await db.$executeRaw`INSERT INTO cash_daily_consolidations(id,company_id,branch_id,business_date,content_hash,snapshot,finalized_by_id) VALUES(${oldDay}::uuid,${legacy.company.id}::uuid,${legacy.branch.id}::uuid,'2026-01-01',${'a'.repeat(64)},'{"businessDate":"2026-01-01","turns":[],"format":"previous"}'::jsonb,${legacy.user.id}::uuid)`
    const oldSnapshot=await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d WHERE id=${oldDay}::uuid`
    sql('BEGIN;\n'+migration('20261106100000_cash_day_close_lock')+'\nCOMMIT;')
    assert.deepEqual(await projection(),before)
    assert.deepEqual(await db.$queryRaw`SELECT to_jsonb(d) AS row FROM cash_daily_consolidations d WHERE id=${oldDay}::uuid`,oldSnapshot)

    await t.test('no existing table gained a required column without a default (older writers keep inserting)', async () => {
      const added = (await columns()).filter(c => tablesBefore.has(c.table_name) && !colsBefore.has(c.table_name + '.' + c.column_name))
      assert.ok(added.length >= 10, `the rehearsal really added columns to existing tables (${added.length})`)
      assert.deepEqual(added.filter(c => c.is_nullable === 'NO' && c.column_default == null).map(c => `${c.table_name}.${c.column_name}`), [])
    })

    await t.test('legacy turns and closures keep their previous flow after everything is applied', async () => {
      await legacy.receipt(db)
      const [{ v }] = await db.$queryRaw`SELECT money_event_version AS v FROM cash_register_sessions WHERE id=${legacy.session.id}::uuid`
      assert.equal(v, 0)
      assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM cash_money_events`)[0].n, 0, 'legacy money never becomes ledger events')
      const [{ flow }] = await db.$queryRaw`SELECT review_flow_version AS flow FROM cash_closures WHERE id=${closureId}::uuid`
      assert.equal(flow, 0)
      await db.$executeRaw`UPDATE cash_closures SET notes='Revisado' WHERE id=${closureId}::uuid`
    })

    await t.test('the new code operates and consolidates a day on the fully migrated schema', async () => {
      const f = await base.fixture(db, 1)
      await db.$executeRaw`UPDATE cash_register_sessions SET status='CLOSED',closed_at=now() WHERE id=${f.session.id}::uuid`
      const view = await require('../src/modules/cash-closure/dailyConsolidation').dayView(db, { ...f.scope, canView: true }, '2026-10-28')
      assert.equal(view.status, 'PROVISIONAL'); assert.deepEqual(view.snapshot.blockers.map(b => b.code), ['PENDING_COUNT'])
    })
  } finally { await db.$disconnect() }
})
