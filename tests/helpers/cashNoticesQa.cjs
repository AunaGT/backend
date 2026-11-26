const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
const reviewQa = require('./cashReviewQa.cjs')
const file = path.join(__dirname, '../../prisma/migrations/20261102100000_cash_payment_notices/migration.sql')
// Base QA aislada (127.0.0.1/auna_cash_virtual_qa): hasta 3C aplicadas y 4A opcional.
async function qaSchema(url, { migrate = true } = {}) {
  const qa = await reviewQa.qaSchema(url)
  const apply = () => qa.sql('BEGIN;\n' + fs.readFileSync(file, 'utf8') + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
// Caja virtual adoptada por el admin, un medio BANK y otro cajero para revisar.
async function fixture(db) {
  const f = await reviewQa.fixture(db)
  const bank = await db.paymentMethod.create({ data: { company_id: f.company.id, name: 'Transferencia QA', settlement_kind: 'BANK' } })
  await db.companyPaymentMethod.create({ data: { company_id: f.company.id, payment_method_id: bank.id } })
  const virtual = { id: randomUUID() }
  await db.$executeRaw`INSERT INTO cash_registers(id,branch_id,name,code,kind,operation_mode,currency_code,updated_at) VALUES(${virtual.id}::uuid,${f.branch.id}::uuid,'Cobros web','WEB','VIRTUAL','INDIVIDUAL','GTQ',now())`
  const admin = { ...f.scope, isAdmin: true }
  const adoption = require('../../src/services/cashEventAdoption')
  await db.$transaction(async tx => {
    const [r] = await tx.$queryRaw`SELECT revision FROM cash_registers WHERE id=${virtual.id}::uuid`
    await adoption.adoptRegister(tx, admin, virtual.id, { eventVersion: 1, expectedRevision: r.revision }, { adoptionEnabled: true })
  })
  const open = (openingFloat = '0.00', scope = f.scope) => db.$transaction(async tx => adoption.openEventSession(tx, scope,
    await require('../../src/services/cashSessionBoundary').lockScopedRegister(tx, scope, virtual.id), { openingFloat, notes: null }))
  return { ...f, bank, virtual, admin, open }
}
module.exports = { qaSchema, fixture, closure: reviewQa.closure }
