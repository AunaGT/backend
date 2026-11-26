const { randomUUID } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const sourceColumns = { SALE: 'sale_id', CUSTOMER_PAYMENT: 'customer_payment_id', CUSTOMER_PAYMENT_REFUND: 'customer_payment_refund_id', RETURN_SETTLEMENT: 'return_settlement_id', SUPPLIER_PAYMENT: 'supplier_payment_id', PHYSICAL_MOVEMENT: 'physical_movement_id', CUSTODY_ENTRY: 'custody_entry_id' }
async function ledgerAvailable(tx) {
  const [row] = await tx.$queryRaw`SELECT to_regclass('cash_money_events') IS NOT NULL AND to_regprocedure('cash_money_source(text,uuid)') IS NOT NULL AS available`
  return row?.available === true
}
async function loadSource(tx, type, id) {
  const rows = await tx.$queryRaw`SELECT * FROM cash_money_source(${type}::text,${id}::uuid)`
  return rows[0] || null
}
async function findEvent(tx, type, id) {
  const rows = await tx.$queryRaw`SELECT * FROM cash_money_events WHERE source_type=${type} AND source_id=${id}::uuid`
  return rows[0] || null
}
async function insertEvent(tx, data) {
  const event = { ...data, id: randomUUID(), [sourceColumns[data.source_type]]: data.source_id }
  // Old sources must keep working before the additive physical-movement DDL is deployed.
  const column = data.source_type === 'PHYSICAL_MOVEMENT' ? Prisma.sql`,physical_movement_id` : data.source_type === 'CUSTODY_ENTRY' ? Prisma.sql`,custody_entry_id` : Prisma.empty
  const value = data.source_type === 'PHYSICAL_MOVEMENT' ? Prisma.sql`,x.physical_movement_id` : data.source_type === 'CUSTODY_ENTRY' ? Prisma.sql`,x.custody_entry_id` : Prisma.empty
  const rows = await tx.$queryRaw`INSERT INTO cash_money_events
    (id,company_id,branch_id,cash_register_id,cash_register_session_id,source_type,source_id,direction,amount,
     payment_method_id,payment_method_name,settlement_kind,currency_code,actor_id,economic_at,reference,content_hash,
     sale_id,customer_payment_id,customer_payment_refund_id,return_settlement_id,supplier_payment_id${column})
    SELECT x.id,x.company_id,x.branch_id,x.cash_register_id,x.cash_register_session_id,x.source_type,x.source_id,x.direction,x.amount,
     x.payment_method_id,x.payment_method_name,x.settlement_kind,x.currency_code,x.actor_id,x.economic_at,x.reference,x.content_hash,
     x.sale_id,x.customer_payment_id,x.customer_payment_refund_id,x.return_settlement_id,x.supplier_payment_id${value}
    FROM json_populate_record(NULL::cash_money_events,${JSON.stringify(event)}::json) x
    ON CONFLICT (source_type,source_id) DO NOTHING RETURNING *`
  return rows[0] || null
}
module.exports = { ledgerAvailable, loadSource, findEvent, insertEvent, sourceColumns }
