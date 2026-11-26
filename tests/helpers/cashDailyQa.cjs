const fs = require('node:fs'), path = require('node:path')
const settlementsQa = require('./cashSettlementsQa.cjs')
const file = path.join(__dirname, '../../prisma/migrations/20261104100000_cash_daily_consolidation/migration.sql')
// Base QA aislada (127.0.0.1/auna_cash_daily_qa): hasta 4B aplicadas y 5 opcional.
async function qaSchema(url, { migrate = true, fixes = true } = {}) {
  const qa = await settlementsQa.qaSchema(url)
  const apply = () => qa.sql('BEGIN;\n' + fs.readFileSync(file, 'utf8') + (fixes ? '\n'+fs.readFileSync(path.join(__dirname,'../../prisma/migrations/20261106100000_cash_day_close_lock/migration.sql'),'utf8') : '') + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
module.exports = { qaSchema, fixture: settlementsQa.fixture }
