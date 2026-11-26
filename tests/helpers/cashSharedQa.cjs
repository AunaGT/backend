const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
const base = require('./cashDailyQa.cjs')
async function qaSchema(url, { migrate = true } = {}) {
  const qa = await base.qaSchema(url)
  const apply = () => qa.sql(fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261119100000_cash_shared_turns/migration.sql'), 'utf8'))
  if (migrate) apply()
  return { ...qa, apply }
}
async function fixture(db) {
  const f = await base.fixture(db)
  const config = require('../../src/modules/sales/cashRegisters.configuration')
  const [r] = await db.$queryRaw`SELECT * FROM cash_registers WHERE id=${f.register2.id}::uuid`
  await db.$transaction(tx => config.saveRegisterConfiguration(tx, f.scope, { id: r.id, requestKey: randomUUID(), expectedRevision: r.revision, name: r.name, operationMode: 'SHARED', enableExplicitAccess: true, authorizedUserIds: [f.user.id, f.other.id] }))
  const open = (scope = f.scope) => db.$transaction(async tx => {
    const r = await require('../../src/services/cashSessionBoundary').lockScopedRegister(tx, scope, f.register2.id)
    return require('../../src/services/cashEventAdoption').openEventSession(tx, scope, r, { openingFloat: '0.00', notes: null })
  })
  return { ...f, sharedRegister: r, open }
}
module.exports = { qaSchema, fixture }
