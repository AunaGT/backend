const { Prisma } = require('@prisma/client')
const { createHash } = require('node:crypto')
const fail = message => { throw Object.assign(new Error(message), { status: 409 }) }
const money = value => new Prisma.Decimal(String(value || 0))
const number = value => money(value).toNumber()
function summarizeMoneyEvents(events, { session = null, start, end }) {
  const currencies = new Set(events.map(row => row.currency_code)); if (session) currencies.add(session.currency_code)
  if (currencies.size > 1) fail('Este período incluye monedas diferentes. Consulta los turnos por moneda; no se convierten ni suman automáticamente.')
  const methods = new Map(), totals = { total_sales: money(0), total_returns: money(0), total_collections: money(0), total_supplier_payments: money(0), total_cash_in: money(0), total_cash_out: money(0), total_custody_in: money(0), total_custody_out: money(0) }
  const methodFor = row => {
    const key = `${row.payment_method_id}:${row.settlement_kind}`
    if (!methods.has(key)) methods.set(key, { breakdown_key: key, payment_method_id: row.payment_method_id, payment_method_name: row.payment_method_name,
      settlement_kind: row.settlement_kind, theoretical_amount: money(0), theoretical_count: 0, sales_detail: [] })
    return methods.get(key)
  }
  let cash = money(0), net = money(0)
  for (const row of [...events].sort((a, b) => +new Date(a.recorded_at) - +new Date(b.recorded_at) || a.id.localeCompare(b.id))) {
    const amount = money(row.amount), signed = row.direction === 'IN' ? amount : amount.neg()
    const method = methodFor(row); method.theoretical_amount = method.theoretical_amount.add(signed); method.theoretical_count++
    net = net.add(signed); if (row.settlement_kind === 'CASH') cash = cash.add(signed)
    const category = row.source_type === 'CUSTODY_ENTRY' ? row.direction === 'IN' ? 'total_custody_in' : 'total_custody_out' : row.source_type === 'PHYSICAL_MOVEMENT' ? row.direction === 'IN' ? 'total_cash_in' : 'total_cash_out' : row.source_type === 'SUPPLIER_PAYMENT' ? 'total_supplier_payments' : row.direction === 'OUT' ? 'total_returns' : row.source_type === 'SALE' ? 'total_sales' : 'total_collections'
    totals[category] = totals[category].add(amount)
    if (row.source_type === 'SALE') method.sales_detail.push({ id: row.source_id, total: number(amount), adjusted_total: number(amount), returned: 0 })
  }
  const opening = money(session?.opening_float)
  if (opening.gt(0)) {
    if (!session.opening_cash_method_id || !session.opening_cash_method_name) fail('El turno no conserva el medio de su fondo inicial. Revisa su configuración; no se inferirá desde el catálogo actual.')
    const method = methodFor({ payment_method_id: session.opening_cash_method_id, payment_method_name: session.opening_cash_method_name, settlement_kind: 'CASH' })
    method.theoretical_amount = method.theoretical_amount.add(opening); net = net.add(opening)
  }
  const sales = events.filter(e => e.source_type === 'SALE')
  const actors = new Map()
  if (session?.operation_mode === 'SHARED') for (const e of events) {
    if (!actors.has(e.actor_id)) actors.set(e.actor_id, { actor_id: e.actor_id, actor_name: e.actor_name || 'Participante', methods: new Map() })
    const actor = actors.get(e.actor_id), key = `${e.payment_method_id}:${e.settlement_kind}`
    if (!actor.methods.has(key)) actor.methods.set(key, { payment_method_id: e.payment_method_id, payment_method_name: e.payment_method_name, settlement_kind: e.settlement_kind, in_amount: money(0), out_amount: money(0) })
    const method = actor.methods.get(key), direction = e.direction === 'IN' ? 'in_amount' : 'out_amount'
    method[direction] = method[direction].add(money(e.amount))
  }
  const participant_breakdown = [...actors.values()].sort((a,b) => a.actor_id.localeCompare(b.actor_id)).map(a => ({ ...a, methods: [...a.methods.values()].map(m => ({ ...m, in_amount: m.in_amount.toFixed(2), out_amount: m.out_amount.toFixed(2) })) }))
  const hash = createHash('sha256').update(JSON.stringify(events.map(e => [e.id, e.content_hash]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex')
  return { period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, calculation_basis: 'EVENTS_V1',
    calculation_basis_label: 'Movimientos inmutables del turno. El fondo inicial se incluye una sola vez.',
    currency_code: session?.currency_code || [...currencies][0] || null, business_timezone: session?.business_timezone || null, event_count: events.length, event_hash: hash,
    ...(session?.operation_mode === 'SHARED' ? { participant_breakdown } : {}),
    theoretical: { ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, number(value)])), net_total: number(net) },
    cash_session: session ? { id: session.id, opening_float: number(opening), cash_sales_amount: number(cash), expected_cash_in_drawer: number(cash.add(opening)) } : null,
    collections: events.filter(e => e.source_type === 'CUSTOMER_PAYMENT').map(e => ({ id: e.source_id, amount: number(e.amount), payment_method: e.payment_method_name, paid_at: e.economic_at, reference: e.reference, customer: null })),
    return_settlements: events.filter(e => e.source_type === 'RETURN_SETTLEMENT').map(e => ({ id: e.source_id, kind: e.direction === 'OUT' ? 'REFUND' : 'COLLECTION', amount: number(e.amount), payment_method: e.payment_method_name, created_at: e.economic_at })),
    advance_refunds: events.filter(e => e.source_type === 'CUSTOMER_PAYMENT_REFUND').map(e => ({ id: e.source_id, amount: number(e.amount), payment_method: e.payment_method_name, confirmed_at: e.economic_at })),
    supplier_payments: events.filter(e => e.source_type === 'SUPPLIER_PAYMENT').map(e => ({ id: e.source_id, amount: number(e.amount), payment_method: e.payment_method_name, paid_at: e.economic_at })),
    unidentified_collections_amount: 0, metrics: { total_transactions: sales.length, total_customers: sales.filter(e => e.customer_present).length, average_ticket: sales.length ? number(totals.total_sales.div(sales.length).toDecimalPlaces(2)) : 0 },
    payment_breakdown: [...methods.values()].map(m => ({ ...m, theoretical_amount: number(m.theoretical_amount) })) }
}
async function calculateEventTheoretical(tx, scope, { session = null, start, end }) {
  if (session) {
    const physical = await require('./physicalMovements').physicalMovementsAvailable(tx), custody = await require('./custody').custodyAvailable(tx)
    const missing = await tx.$queryRaw(Prisma.sql`WITH origins AS (
      SELECT 'SALE'::text AS type,id FROM sales WHERE cash_register_session_id=${session.id}::uuid
      UNION ALL SELECT 'CUSTOMER_PAYMENT',id FROM customer_payments WHERE cash_register_session_id=${session.id}::uuid
      UNION ALL SELECT 'CUSTOMER_PAYMENT_REFUND',id FROM customer_payment_refunds WHERE cash_register_session_id=${session.id}::uuid
      UNION ALL SELECT 'RETURN_SETTLEMENT',id FROM return_settlements WHERE cash_register_session_id=${session.id}::uuid
      UNION ALL SELECT 'SUPPLIER_PAYMENT',id FROM supplier_payments WHERE cash_register_session_id=${session.id}::uuid
      ${physical ? Prisma.sql`UNION ALL SELECT 'PHYSICAL_MOVEMENT',id FROM cash_physical_movements WHERE cash_register_session_id=${session.id}::uuid` : Prisma.empty}
      ${custody ? Prisma.sql`UNION ALL SELECT 'CUSTODY_ENTRY',id FROM cash_custody_entries WHERE cash_register_session_id=${session.id}::uuid` : Prisma.empty})
      SELECT o.id FROM origins o CROSS JOIN LATERAL cash_money_source(o.type,o.id) source
      WHERE source.eligible AND source.amount>0 AND NOT EXISTS(SELECT 1 FROM cash_money_events e WHERE e.source_type=o.type AND e.source_id=o.id) LIMIT 1`)
    if (missing.length) fail('El turno tiene un origen de dinero sin movimiento canónico. Requiere revisión; no se completará usando cálculos históricos.')
  }
  const rows = session ? await tx.$queryRaw`SELECT e.*,u.name AS actor_name,s.customer IS NOT NULL AND s.customer<>'Desconocido' AS customer_present FROM cash_money_events e JOIN users u ON u.id=e.actor_id LEFT JOIN sales s ON s.id=e.sale_id
    WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid AND e.cash_register_session_id=${session.id}::uuid ORDER BY e.recorded_at,e.id`
    : await tx.$queryRaw`SELECT e.*,s.customer IS NOT NULL AND s.customer<>'Desconocido' AS customer_present FROM cash_money_events e LEFT JOIN sales s ON s.id=e.sale_id
    WHERE e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid AND e.recorded_at>=${start}::timestamptz AND e.recorded_at<=${end}::timestamptz ORDER BY e.recorded_at,e.id`
  const result = summarizeMoneyEvents(rows, { session, start, end })
  if (session?.operation_mode === 'SHARED') result.cash_session = { ...result.cash_session, operation_mode: 'SHARED', participants: await require('../../services/cashSharedSessions').participants(tx, session.id) }
  return result
}
async function legacyRows(tx, rows) {
  const ids = [...new Set(rows.map(row => row.cash_register_session_id).filter(Boolean))]
  if (!ids.length) return rows
  const adopted = await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id=ANY(${ids}::uuid[]) AND money_event_version=1`
  const excluded = new Set(adopted.map(row => row.id))
  return rows.filter(row => !excluded.has(row.cash_register_session_id))
}
function mergeTheoretical(legacy, events) {
  if (!events.event_count) return { ...legacy, calculation_basis: 'LEGACY', calculation_basis_label: 'Compatibilidad histórica por fechas. No es una consolidación diaria de turnos.', event_count: 0, event_hash: events.event_hash }
  const methods = new Map()
  for (const method of [...legacy.payment_breakdown, ...events.payment_breakdown]) {
    const key = method.breakdown_key || `${method.payment_method_id}:${method.settlement_kind || 'LEGACY'}`
    const previous = methods.get(key)
    methods.set(key, previous ? { ...previous, theoretical_amount: number(money(previous.theoretical_amount).add(method.theoretical_amount)), theoretical_count: previous.theoretical_count + method.theoretical_count,
      sales_detail: [...(previous.sales_detail || []), ...(method.sales_detail || [])] } : { ...method, breakdown_key: key })
  }
  const theoretical = Object.fromEntries(['total_sales', 'total_returns', 'total_collections', 'total_supplier_payments', 'total_cash_in', 'total_cash_out', 'total_custody_in', 'total_custody_out', 'net_total'].map(key => [key, number(money(legacy.theoretical[key]).add(money(events.theoretical[key])))]))
  const legacyCount = legacy.payment_breakdown.reduce((sum, row) => sum + row.theoretical_count, 0) || legacy.unidentified_collections_amount
  const count = legacy.metrics.total_transactions + events.metrics.total_transactions
  return { ...legacy, theoretical, payment_breakdown: [...methods.values()], collections: [...legacy.collections, ...events.collections], return_settlements: [...legacy.return_settlements, ...events.return_settlements],
    advance_refunds: [...legacy.advance_refunds, ...events.advance_refunds], supplier_payments: [...(legacy.supplier_payments || []), ...events.supplier_payments], event_count: events.event_count, event_hash: events.event_hash,
    currency_code: events.currency_code, calculation_basis: legacyCount ? 'MIXED' : 'EVENTS_V1',
    calculation_basis_label: 'Consulta por período: legado según fechas históricas y movimientos nuevos según fecha real de registro, sin duplicarlos. No es una consolidación diaria de turnos.',
    metrics: { total_transactions: count, total_customers: legacy.metrics.total_customers + events.metrics.total_customers, average_ticket: count ? number(money(theoretical.total_sales).div(count).toDecimalPlaces(2)) : 0 } }
}
module.exports = { summarizeMoneyEvents, calculateEventTheoretical, legacyRows, mergeTheoretical }
