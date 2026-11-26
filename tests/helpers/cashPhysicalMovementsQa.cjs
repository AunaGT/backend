const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const base = require('./cashRegisterAccessQa.cjs')
async function qaSchema(url, { migrate = true } = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1'); assert.equal(new URL(url).pathname, '/auna_cash_movements_qa')
  const qa = await require('./cashMoneyEventsQa.cjs').qaSchema(url, { qaDatabase: 'auna_cash_movements_qa' })
  qa.sql('DROP TABLE IF EXISTS cash_register_commands; DROP TABLE IF EXISTS cash_register_access; ALTER TABLE cash_registers DROP COLUMN IF EXISTS access_control_version;')
  qa.sql('BEGIN;\n' + fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261029150000_cash_register_access/migration.sql'), 'utf8') + '\nCOMMIT;')
  const apply = () => qa.sql('BEGIN;\n' + fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261030100000_cash_physical_movements/migration.sql'), 'utf8') + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
async function insertMovement(db, f, changes = {}) {
  const { randomUUID } = require('node:crypto')
  const id = randomUUID(), key = randomUUID()
  const value = { id, company_id: f.company.id, branch_id: f.branch.id, cash_register_id: f.register.id, cash_register_session_id: f.session.id,
    actor_id: f.user.id, request_key: key, request_hash: 'a'.repeat(64), direction: 'IN', amount: '10.00', payment_method_id: f.method.id,
    payment_method_name: f.method.name, currency_code: 'GTQ', reason: 'Fondo real QA', counterparty_label: 'Caja fuerte QA', ...changes }
  return (await db.$queryRaw`INSERT INTO cash_physical_movements(id,company_id,branch_id,cash_register_id,cash_register_session_id,actor_id,request_key,request_hash,direction,amount,payment_method_id,payment_method_name,currency_code,reason,counterparty_label,corrects_movement_id)
    SELECT x.id,x.company_id,x.branch_id,x.cash_register_id,x.cash_register_session_id,x.actor_id,x.request_key,x.request_hash,x.direction,x.amount,x.payment_method_id,x.payment_method_name,x.currency_code,x.reason,x.counterparty_label,x.corrects_movement_id
    FROM json_populate_record(NULL::cash_physical_movements,${JSON.stringify(value)}::json) x RETURNING *`)[0]
}
async function insertEvent(db, m) {
  await db.$executeRaw`INSERT INTO cash_money_events(company_id,branch_id,cash_register_id,cash_register_session_id,source_type,source_id,physical_movement_id,direction,amount,payment_method_id,payment_method_name,settlement_kind,currency_code,actor_id,economic_at,reference,content_hash)
    VALUES(${m.company_id}::uuid,${m.branch_id}::uuid,${m.cash_register_id}::uuid,${m.cash_register_session_id}::uuid,'PHYSICAL_MOVEMENT',${m.id}::uuid,${m.id}::uuid,${m.direction},${m.amount}::numeric,${m.payment_method_id},${m.payment_method_name},'CASH',${m.currency_code},${m.actor_id}::uuid,${m.economic_at},${m.reference},${'b'.repeat(64)})`
}
module.exports = { qaSchema, fixture: (db, version = 1) => base.fixture(db, version), insertMovement, insertEvent }
