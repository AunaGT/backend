async function hydrateClosureSnapshots(tx, closures) {
  if (!closures.length || !await require('./eventStorage').ledgerAvailable(tx)) return closures
  const rows = await tx.$queryRaw`SELECT id,calculation_snapshot FROM cash_closures WHERE id=ANY(${closures.map(c => c.id)}::uuid[])`
  const snapshots = new Map(rows.map(row => [row.id, row.calculation_snapshot]))
  return closures.map(closure => {
    const snapshot = snapshots.get(closure.id)
    if (!snapshot) return closure
    const byId = new Map(snapshot.payment_breakdowns.map(row => [row.id, row]))
    return { ...closure, calculation_snapshot: snapshot, calculation_basis: snapshot.basis, currency_code: snapshot.currency_code,
      payment_breakdowns: closure.payment_breakdowns?.map(row => {
        const frozen = byId.get(row.id)
        return frozen ? { ...row, breakdown_key: frozen.breakdown_key, settlement_kind: frozen.settlement_kind, payment_method_name: frozen.payment_method_name,
          payment_method: { ...row.payment_method, name: frozen.payment_method_name, settlement_kind: frozen.settlement_kind } } : row
      }) }
  })
}
async function saveClosureSnapshot(tx, savedId, data, payments) {
  if (!await require('./eventStorage').ledgerAvailable(tx)) return
  const snapshot = { version: 1, basis: data.calculation_basis, basis_label: data.calculation_basis_label, currency_code: data.currency_code || null,
    business_timezone: data.business_timezone || null, period: data.period, event_count: data.event_count || 0, event_hash: data.event_hash || null, calculation_key: data.calculation_key,
    theoretical: data.theoretical, cash_session: data.cash_session, ...(data.participant_breakdown ? { participant_breakdown: data.participant_breakdown } : {}), payment_breakdowns: payments.map(payment => ({ ...payment, ...data.payment_breakdown.find(row => (row.breakdown_key || row.payment_method_id) === (payment.breakdown_key || payment.payment_method_id)) })) }
  await tx.$executeRaw`UPDATE cash_closures SET calculation_snapshot=${JSON.stringify(snapshot)}::jsonb WHERE id=${savedId}::uuid`
}
module.exports = { hydrateClosureSnapshots, saveClosureSnapshot }
