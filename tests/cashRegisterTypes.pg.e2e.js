const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { spawnSync } = require('node:child_process')
const qaUrl = process.env.AUNA_CASH_TYPES_QA_URL
test('cash register metadata preserves legacy records and enforces physical/virtual snapshots', { skip: !qaUrl }, async t => {
  const url = new URL(qaUrl)
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/auna_cash_qa_metadata')
  function sql(input, valid = true) {
    const result = spawnSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', qaUrl], { input, encoding: 'utf8' })
    if (valid) assert.equal(result.status, 0, result.stderr)
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, /cash_(session|register)/) }
    return result.stdout.trim()
  }
  const baseline = fs.readFileSync(path.join(__dirname, '../prisma/migrations/0_auna_baseline_20261015/migration.sql'), 'utf8')
  const definition = name => {
    const start = baseline.indexOf(`CREATE ${name.startsWith('"') ? 'TYPE' : 'TABLE'} public.${name} `)
    assert.ok(start >= 0)
    return baseline.slice(start, baseline.indexOf('\n);', start) + 4)
  }
  sql(definition('"CashRegisterSessionStatus"') + definition('cash_registers') + definition('cash_register_sessions'))
  const register = '11111111-1111-4111-8111-111111111111', session = '22222222-2222-4222-8222-222222222222', virtual = '33333333-3333-4333-8333-333333333333', branch = '44444444-4444-4444-8444-444444444444', user = '55555555-5555-4555-8555-555555555555'
  sql(`ALTER TABLE cash_registers ADD PRIMARY KEY(id); ALTER TABLE cash_register_sessions ADD PRIMARY KEY(id);
    INSERT INTO cash_registers(id,name,code,branch_id,updated_at) VALUES('${register}','Legado','LEG','${branch}','2026-10-28');
    INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,notes,updated_at) VALUES('${session}','${register}','${user}',125.75,'Conservar','2026-10-28');`)
  const oldProjection = `SELECT row_to_json(r) FROM (SELECT id,name,code,is_default,active,created_at,updated_at,branch_id FROM cash_registers WHERE id='${register}') r;
    SELECT row_to_json(s) FROM (SELECT id,cash_register_id,status,opened_at,closed_at,opened_by_id,closed_by_id,opening_float,notes,cash_closure_id,created_at,updated_at FROM cash_register_sessions WHERE id='${session}') s;`
  const before = sql(oldProjection)
  sql(fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261028190000_cash_register_types/migration.sql'), 'utf8'))
  assert.equal(sql(oldProjection), before)
  assert.equal(sql(`SELECT kind||'/'||operation_mode FROM cash_registers WHERE id='${register}'`), 'PHYSICAL/INDIVIDUAL')
  assert.equal(sql(`SELECT (register_type IS NULL AND operation_mode IS NULL AND currency_code IS NULL AND business_date IS NULL)::text FROM cash_register_sessions WHERE id='${session}'`), 'true')
  sql(`INSERT INTO cash_registers(id,name,code,branch_id,updated_at,kind,currency_code) VALUES('${virtual}','Web','WEB','${branch}',now(),'VIRTUAL','GTQ')`)
  const insertSession = (type, mode, currency, date, amount) => `INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date) VALUES(gen_random_uuid(),'${virtual}','${user}',${amount},now(),${type},${mode},${currency},${date})`
  sql(insertSession('NULL', 'NULL', 'NULL', 'NULL', 0), false)
  sql(insertSession("'VIRTUAL'", "'INDIVIDUAL'", "'GTQ'", "'2026-10-28'", 10), false)
  sql(insertSession("'PHYSICAL'", "'INDIVIDUAL'", "'GTQ'", "'2026-10-28'", 0), false)
  sql(insertSession("'VIRTUAL'", "'INDIVIDUAL'", "'USD'", "'2026-10-28'", 0), false)
  sql(insertSession("'VIRTUAL'", 'NULL', "'GTQ'", "'2026-10-28'", 0), false)
  sql(insertSession("'VIRTUAL'", "'INDIVIDUAL'", "'GTQ'", "'2026-10-28'", 0))
  sql(`UPDATE cash_register_sessions SET notes='Revisión' WHERE cash_register_id='${virtual}'`)
  sql(`UPDATE cash_register_sessions SET business_date='2026-10-29' WHERE cash_register_id='${virtual}'`, false)
  sql(`UPDATE cash_registers SET kind='VIRTUAL',currency_code='GTQ' WHERE id='${register}'`, false)
  sql(`UPDATE cash_registers SET operation_mode='SHARED' WHERE id='${register}'`, false)
  sql(`UPDATE cash_register_sessions SET status='CLOSED' WHERE id='${session}'; UPDATE cash_registers SET operation_mode='SHARED' WHERE id='${register}'`)
  await t.test('a complete physical snapshot requires a configured parent currency', () => {
    const physical = sql(`INSERT INTO cash_registers(id,name,code,branch_id,updated_at) VALUES(gen_random_uuid(),'Moneda pendiente','CUR','${branch}',now()) RETURNING id`)
    sql(`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date)
      VALUES(gen_random_uuid(),'${physical}','${user}',0,now(),'PHYSICAL','INDIVIDUAL','USD','2026-10-28')`, false)
  })
  await t.test('unchanged historical snapshots survive a later allowed mode change', () => {
    const physical = sql(`INSERT INTO cash_registers(id,name,code,branch_id,updated_at,currency_code) VALUES(gen_random_uuid(),'Historial','HIS','${branch}',now(),'GTQ') RETURNING id`)
    const declared = sql(`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date)
      VALUES(gen_random_uuid(),'${physical}','${user}',25,now(),'PHYSICAL','INDIVIDUAL','GTQ','2026-10-28') RETURNING id`)
    sql(`UPDATE cash_register_sessions SET status='CLOSED' WHERE id='${declared}'; UPDATE cash_registers SET operation_mode='SHARED' WHERE id='${physical}'`)
    sql(`UPDATE cash_register_sessions SET notes='Histórico intacto',opening_float=opening_float,register_type=register_type,operation_mode=operation_mode,currency_code=currency_code,business_date=business_date WHERE id='${declared}'`)
    assert.equal(sql(`SELECT operation_mode||'/'||opening_float FROM cash_register_sessions WHERE id='${declared}'`), 'INDIVIDUAL/25.00')
    sql(`UPDATE cash_register_sessions SET opening_float=26 WHERE id='${declared}'`, false)
    sql(`UPDATE cash_register_sessions SET register_type=NULL,operation_mode=NULL,currency_code=NULL,business_date=NULL WHERE id='${declared}'`, false)
    sql(`UPDATE cash_register_sessions SET cash_register_id='${virtual}' WHERE id='${declared}'`, false)
    sql(`UPDATE cash_register_sessions SET cash_closure_id='77777777-7777-4777-8777-777777777777' WHERE id='${declared}'`)
    sql(`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date)
      VALUES(gen_random_uuid(),'${physical}','${user}',0,now(),'PHYSICAL','SHARED','GTQ','2026-10-29')`)
  })
  const { PrismaClient } = require('@prisma/client')
  const client = new PrismaClient({ datasources: { db: { url: qaUrl } } })
  const writer = new PrismaClient({ datasources: { db: { url: qaUrl } } })
  try {
    for (const field of ['kind', 'operation_mode']) await t.test(`a concurrent first session prevents stale Repeatable Read ${field} changes`, async () => {
      const physical = sql(`INSERT INTO cash_registers(id,name,code,branch_id,updated_at,currency_code) VALUES(gen_random_uuid(),'Concurrente','RR${field}','${branch}',now(),'GTQ') RETURNING id`)
      await assert.rejects(client.$transaction(async tx => {
        await tx.$queryRawUnsafe(`SELECT id FROM cash_registers WHERE id='${physical}'`)
        await writer.$executeRawUnsafe(`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,register_type,operation_mode,currency_code,business_date)
          VALUES(gen_random_uuid(),'${physical}','${user}',0,now(),'PHYSICAL','INDIVIDUAL','GTQ','2026-10-28')`)
        await tx.$executeRawUnsafe(`UPDATE cash_registers SET ${field}='${field === 'kind' ? 'VIRTUAL' : 'SHARED'}' WHERE id='${physical}'`)
      }, { isolationLevel: 'RepeatableRead' }), error => error.code === 'P2034' || error.meta?.code === '40001')
      assert.equal(sql(`SELECT kind||'/'||operation_mode FROM cash_registers WHERE id='${physical}'`), 'PHYSICAL/INDIVIDUAL')
    })
  } finally { await Promise.all([client.$disconnect(), writer.$disconnect()]) }
})
