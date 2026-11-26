const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const base = require('./cashMoneyEventsQa.cjs')
async function qaSchema(url, { migrate = true } = {}) {
  assert.equal(new URL(url).pathname, '/auna_cash_access_qa')
  const qa = await base.qaSchema(url, { qaDatabase: 'auna_cash_access_qa' })
  qa.sql(`DROP TABLE IF EXISTS cash_register_commands; DROP TABLE IF EXISTS cash_register_access; ALTER TABLE cash_registers DROP COLUMN IF EXISTS access_control_version;`)
  const apply = () => qa.sql('BEGIN;\n' + fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261029150000_cash_register_access/migration.sql'), 'utf8') + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
async function fixture(db, version = 0) {
  const f = await base.fixture(db, version)
  await db.userCompany.create({ data: { company_id: f.company.id, user_id: f.user.id, role_id: f.user.role_id } })
  await db.userBranch.create({ data: { branch_id: f.branch.id, user_id: f.user.id } })
  return f
}
module.exports = { qaSchema, fixture }
