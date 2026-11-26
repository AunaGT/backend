const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
const base = require('./cashMoneyEventsQa.cjs')
const migration = name => fs.readFileSync(path.join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8')
// Base QA aislada (127.0.0.1/auna_cash_custody_qa, esquema nuevo): 2B.2 → 3A → 3B.1 aplicadas y 3B.2 opcional.
async function qaSchema(url, { migrate = true } = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1'); const qaDatabase = new URL(url).pathname.slice(1)
  assert.ok(['auna_cash_custody_qa', 'auna_cash_review_qa', 'auna_cash_virtual_qa', 'auna_cash_settlement_qa', 'auna_cash_daily_qa', 'auna_cash_disputes_qa'].includes(qaDatabase))
  const qa = await base.qaSchema(url, { qaDatabase })
  qa.sql('DROP TABLE IF EXISTS cash_register_commands; DROP TABLE IF EXISTS cash_register_access; ALTER TABLE cash_registers DROP COLUMN IF EXISTS access_control_version;')
  qa.sql('BEGIN;\n' + migration('20261029150000_cash_register_access') + '\nCOMMIT;')
  qa.sql('BEGIN;\n' + migration('20261030100000_cash_physical_movements') + '\nCOMMIT;')
  // El cliente generado lee opening_inherited_amount, así que la base la conserva; 3B.2 la vuelve a crear con sus guardas.
  const apply = () => qa.sql('BEGIN;\nALTER TABLE cash_register_sessions DROP COLUMN opening_inherited_amount;\n' + migration('20261031100000_cash_custody') + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
async function fixture(db) {
  const f = await base.fixture(db, 1)
  await db.userCompany.create({ data: { company_id: f.company.id, user_id: f.user.id, role_id: f.user.role_id } })
  await db.userBranch.create({ data: { branch_id: f.branch.id, user_id: f.user.id } })
  const other = await db.user.create({ data: { name: 'Receiver QA', email: `${randomUUID()}@example.invalid`, password: 'qa-not-a-login', role_id: f.user.role_id } })
  await db.userCompany.create({ data: { company_id: f.company.id, user_id: other.id, role_id: f.user.role_id } })
  await db.userBranch.create({ data: { branch_id: f.branch.id, user_id: other.id } })
  const register2 = await db.cashRegister.create({ data: { branch_id: f.branch.id, name: 'QA 2', code: 'QA2' } })
  await db.$executeRaw`UPDATE cash_registers SET currency_code='GTQ',money_event_version=1 WHERE id=${register2.id}::uuid`
  return { ...f, other, register2, otherScope: { ...f.scope, userId: other.id } }
}
async function custody(db, f, name = 'Caja fuerte') {
  const id = randomUUID()
  await db.$executeRaw`INSERT INTO cash_custodies(id,company_id,branch_id,name,currency_code,created_by_id) VALUES(${id}::uuid,${f.company.id}::uuid,${f.branch.id}::uuid,${name},'GTQ',${f.user.id}::uuid)`
  return id
}
module.exports = { qaSchema, fixture, custody }
