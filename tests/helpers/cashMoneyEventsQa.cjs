const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { randomUUID } = require('node:crypto'), { execFileSync, spawnSync } = require('node:child_process')
const { PrismaClient } = require('@prisma/client')
const backend = path.resolve(__dirname, '../..')
async function qaSchema(qaUrl, { migrate = true, qaDatabase = 'auna_cash_events_qa' } = {}) {
  const url = new URL(qaUrl)
  assert.ok(['auna_cash_events_qa', 'auna_cash_access_qa', 'auna_cash_movements_qa', 'auna_cash_custody_qa', 'auna_cash_review_qa', 'auna_cash_virtual_qa', 'auna_cash_settlement_qa', 'auna_cash_daily_qa', 'auna_cash_disputes_qa', 'auna_cash_rollout_qa'].includes(qaDatabase))
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/' + qaDatabase)
  const schema = 'cash_events_' + randomUUID().replaceAll('-', '')
  url.searchParams.set('schema', schema)
  process.env.DATABASE_URL = url.href; process.env.DIRECT_URL = url.href
  const sql = input => {
    const result = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', qaUrl], { input: `SET search_path TO "${schema}";\n${input}`, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr); return result.stdout
  }
  const ddl = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], {
    cwd: backend, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
  }).replaceAll('"public"', `"${schema}"`)
  sql(ddl)
  // Only the newly created, empty QA schema is reduced to the pre-event baseline.
  sql(`DROP TABLE IF EXISTS cash_daily_consolidations; DROP TABLE IF EXISTS cash_settlement_deductions; DROP TABLE IF EXISTS cash_settlement_allocations; DROP TABLE IF EXISTS cash_settlements; DROP TABLE IF EXISTS cash_bank_deposits; DROP TABLE IF EXISTS cash_bank_event_modes; DROP TABLE IF EXISTS cash_bank_method_settings; DROP TABLE IF EXISTS cash_bank_method_versions; DROP TABLE IF EXISTS cash_payment_notices; DROP TABLE IF EXISTS cash_closure_reviews; DROP TABLE IF EXISTS cash_difference_policies;
    ALTER TABLE cash_closures DROP COLUMN IF EXISTS supersedes_closure_id, DROP COLUMN IF EXISTS review_flow_version, DROP COLUMN IF EXISTS policy_snapshot, DROP COLUMN IF EXISTS review_result, DROP COLUMN IF EXISTS review_classification;
    DROP TABLE IF EXISTS cash_money_events;
    DROP TABLE IF EXISTS cash_custody_entries; DROP TABLE IF EXISTS cash_custody_transfers; DROP TABLE IF EXISTS cash_turn_handovers; DROP TABLE IF EXISTS cash_custodies;
    DROP TABLE IF EXISTS cash_physical_movements;
    ALTER TABLE cash_registers DROP COLUMN IF EXISTS money_event_version;
    ALTER TABLE cash_register_sessions DROP COLUMN IF EXISTS money_event_version, DROP COLUMN IF EXISTS business_timezone, DROP COLUMN IF EXISTS opening_cash_method_id, DROP COLUMN IF EXISTS opening_cash_method_name;
    ALTER TABLE supplier_payments DROP COLUMN IF EXISTS cash_register_session_id;
    ALTER TABLE customer_payments DROP COLUMN IF EXISTS request_key, DROP COLUMN IF EXISTS request_hash;
    ALTER TABLE cash_closures DROP COLUMN IF EXISTS calculation_snapshot;`)
  const types = fs.readFileSync(path.join(backend, 'prisma/migrations/20261028190000_cash_register_types/migration.sql'), 'utf8')
  sql(types.slice(types.indexOf('CREATE FUNCTION protect_cash_register_identity')))
  const apply = () => sql('BEGIN;\n' + fs.readFileSync(path.join(backend, 'prisma/migrations/20261028210000_cash_money_events/migration.sql'), 'utf8') + '\nCOMMIT;')
  const db = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] })
  if (migrate) apply()
  return { db, sql, apply, url: url.href, schema }
}
async function fixture(db, version = 1) {
  const company = await db.company.create({ data: { name: 'Money QA', code: randomUUID().slice(0, 12) } })
  await db.systemSetting.create({ data: { company_id: company.id, key: 'currency_code', value: 'GTQ' } })
  const branch = await db.branch.create({ data: { company_id: company.id, name: 'QA', code: 'QA' } })
  const role = await db.role.create({ data: { name: 'Cashier QA', company_id: company.id } })
  const user = await db.user.create({ data: { name: 'Cashier QA', email: `${randomUUID()}@example.invalid`, password: 'qa-not-a-login', role_id: role.id } })
  const customer = await db.supplier.create({ data: { company_id: company.id, name: 'Customer QA', contact: 'QA', party_type: 'CUSTOMER' } })
  const method = await db.paymentMethod.create({ data: { company_id: company.id, name: 'Efectivo QA', settlement_kind: 'CASH' } })
  await db.companyPaymentMethod.create({ data: { company_id: company.id, payment_method_id: method.id } })
  // Caja, turno y cobro por SQL: el cliente generado lee columnas de 2B.2 que la base QA aún no tiene antes de migrar.
  const register = { id: randomUUID() }
  await db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,updated_at) VALUES(${register.id}::uuid,${branch.id}::uuid,'QA','QA',now())`
  let session
  if (version === 1) {
    await db.$executeRaw`UPDATE cash_registers SET currency_code='GTQ',money_event_version=1 WHERE id=${register.id}::uuid`
    const id = randomUUID()
    await db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at,
      register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version,opening_cash_method_id,opening_cash_method_name)
      VALUES(${id}::uuid,${register.id}::uuid,${user.id}::uuid,200,now(),'PHYSICAL','INDIVIDUAL','GTQ','2026-10-28','America/Guatemala',1,${method.id},${method.name})`
    session = { id }
  } else {
    session = { id: randomUUID() }
    await db.$executeRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,updated_at) VALUES(${session.id}::uuid,${register.id}::uuid,${user.id}::uuid,200,now())`
  }
  const scope = { companyId: company.id, branchId: branch.id, userId: user.id, isAdmin: false }
  const receipt = async tx => {
    const id = randomUUID()
    await tx.$executeRaw`INSERT INTO customer_payments(id,branch_id,customer_id,amount,payment_method_id,cash_register_session_id,registered_by,paid_at)
      VALUES(${id}::uuid,${branch.id}::uuid,${customer.id}::uuid,50,${method.id},${session.id}::uuid,${user.id}::uuid,'2026-10-28T12:00:00Z')`
    return { id }
  }
  const locked = tx => require('../../src/services/cashSessionBoundary').lockScopedSession(tx, scope, session.id)
  return { company, branch, user, customer, method, register, session, scope, receipt, locked }
}
module.exports = { qaSchema, fixture }
