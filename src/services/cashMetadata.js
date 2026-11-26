const { Prisma } = require('@prisma/client')
async function hydrateCashMetadata(db, rows, kind = 'sessions') {
  if (!rows.length || !await require('../modules/cash-closure/eventStorage').ledgerAvailable(db)) return rows
  const table = kind === 'registers' ? Prisma.raw('cash_registers') : Prisma.raw('cash_register_sessions')
  const columns = kind === 'registers' ? Prisma.raw('id,kind,operation_mode,currency_code,revision,money_event_version') : Prisma.raw('id,register_type,operation_mode,currency_code,business_date,business_timezone,revision,money_event_version,opening_cash_method_id,opening_cash_method_name')
  const metadata = await db.$queryRaw(Prisma.sql`SELECT ${columns} FROM ${table} WHERE id=ANY(${rows.map(row => row.id)}::uuid[])`)
  const byId = new Map(metadata.map(row => [row.id, row]))
  return rows.map(row => ({ ...row, ...byId.get(row.id) }))
}
module.exports = { hydrateCashMetadata }
