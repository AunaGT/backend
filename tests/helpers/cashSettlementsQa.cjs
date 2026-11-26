const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto')
const noticesQa = require('./cashNoticesQa.cjs')
const file = path.join(__dirname, '../../prisma/migrations/20261103100000_cash_bank_settlements/migration.sql')
// Base QA aislada (127.0.0.1/auna_cash_settlement_qa): hasta 4A aplicadas y 4B opcional.
async function qaSchema(url, { migrate = true } = {}) {
  const qa = await noticesQa.qaSchema(url)
  const apply = () => qa.sql('BEGIN;\n' + fs.readFileSync(file, 'utf8') + '\nCOMMIT;')
  if (migrate) apply()
  return { ...qa, apply }
}
// Caja virtual, medios Tarjeta (CARD) y Transferencia y cuentas contables de la empresa.
async function fixture(db) {
  const f = await noticesQa.fixture(db)
  const card = await db.paymentMethod.create({ data: { company_id: f.company.id, name: 'Tarjeta QA', settlement_kind: 'BANK' } })
  await db.companyPaymentMethod.create({ data: { company_id: f.company.id, payment_method_id: card.id } })
  const account = (code, name, type) => db.account.create({ data: { company_id: f.company.id, code, name, type } })
  const accounts = { bank: await account('1102', 'Banco Industrial', 'ASSET'), clearing: await account('1105', 'Cobros por liquidar', 'ASSET'),
    fee: await account('6105', 'Comisiones bancarias', 'EXPENSE'), income: await account('4101', 'Ventas', 'INCOME') }
  return { ...f, card, accounts, period: await f.open() }
}
module.exports = { qaSchema, fixture, randomUUID }
