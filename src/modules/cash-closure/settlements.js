const { createHash, randomUUID } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { exactMoney } = require('../receivables/paymentAttempts')
const { accountingEnabled } = require('./bankMethods')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const D = value => new Prisma.Decimal(String(value ?? 0))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const id = (value, label) => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, 'CASH_SETTLEMENT_INPUT', `${label} no es válido`); return value }
const day = (value, label) => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) fail(400, 'CASH_SETTLEMENT_INPUT', `${label} no es una fecha válida`); return value }
const text = (value, label, max) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, 'CASH_SETTLEMENT_INPUT', `${label}: hasta ${max} caracteres`); return value.trim() }

async function settlementsAvailable(db) { return (await db.$queryRaw`SELECT to_regclass('cash_settlements') IS NOT NULL AS ok`)[0]?.ok === true }
async function requireAvailable(db) { if (!await settlementsAvailable(db)) fail(409, 'CASH_SETTLEMENT_UNAVAILABLE', 'Las liquidaciones todavía no están disponibles.') }
async function guarded(work) {
  try { return await work() } catch (e) {
    const m = String(e?.message || '')
    if (/dispute_settlement_dependency/.test(m)) fail(409, 'CASH_SETTLEMENT_DISPUTE_DEPENDENCY', 'La liquidación respalda un contracargo. Revisa y compensa sus movimientos vinculados antes de anularla.')
    if (/cash_settlement_exceeds|cash_settlement_allocation/.test(m)) fail(409, 'CASH_SETTLEMENT_ALLOCATION', 'Un cobro ya no tiene ese saldo pendiente o no se liquida con este depósito. Recarga lo pendiente.')
    if (/cash_settlement_deposit_total/.test(m)) fail(409, 'CASH_SETTLEMENT_DEPOSIT_TOTAL', 'Las liquidaciones superarían el total del depósito.')
    if (/cash_settlement_deposit/.test(m)) fail(409, 'CASH_SETTLEMENT_DEPOSIT', 'El medio no tiene una configuración diferida aprobada para registrar depósitos.')
    if (/cash_settlement_account/.test(m)) fail(409, 'CASH_SETTLEMENT_ACCOUNT', 'La cuenta de una deducción no es válida para la empresa.')
    if (/cash_settlement_totals/.test(m)) fail(400, 'CASH_SETTLEMENT_BALANCE', 'Los totales no coinciden con las asignaciones y deducciones.')
    if (/cash_settlement_state/.test(m)) fail(409, 'CASH_SETTLEMENT_STATE', 'La liquidación cambió. Recarga su estado actual.')
    throw e
  }
}
const money = v => D(v).toFixed(2)
const civil = v => v ? new Date(v).toISOString().slice(0, 10) : null

async function getDeposit(db, scope, depositId) {
  await requireAvailable(db)
  const [d] = await db.$queryRaw`SELECT d.*,pm.name AS payment_method_name,v.destination_label,
    coalesce((SELECT sum(net) FROM cash_settlements WHERE deposit_id=d.id AND status='POSTED'),0) AS distributed FROM cash_bank_deposits d
    JOIN payment_methods pm ON pm.id=d.payment_method_id JOIN cash_bank_method_versions v ON v.id=d.version_id WHERE d.id::text=${String(depositId)} AND d.company_id=${scope.companyId}::uuid`
  if (!d) fail(404, 'CASH_SETTLEMENT_NOT_FOUND', 'Depósito no encontrado')
  const settlements = await db.$queryRaw`SELECT s.id,s.status,s.net,b.name AS branch_name,s.created_at FROM cash_settlements s JOIN branches b ON b.id=s.branch_id WHERE s.deposit_id=${d.id}::uuid ORDER BY s.created_at`
  return { ...d, total_amount: money(d.total_amount), distributed: money(d.distributed), pending: D(d.total_amount).sub(D(d.distributed)).toFixed(2), deposited_on: civil(d.deposited_on),
    settlements: settlements.map(s => ({ ...s, net: money(s.net) })) }
}
async function findDeposit(db, scope, { paymentMethodId, reference }) {
  const [d] = await db.$queryRaw`SELECT id FROM cash_bank_deposits WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${Number(paymentMethodId)} AND reference=${String(reference || '').trim()}`
  return d ? getDeposit(db, scope, d.id) : null
}

// Depósito existente (por id o referencia) o nuevo con la versión diferida vigente. Misma referencia con otro total o fecha: conflicto.
async function resolveDeposit(tx, scope, methodId, raw) {
  if (raw?.id) {
    const [d] = await tx.$queryRaw`SELECT * FROM cash_bank_deposits WHERE id=${id(raw.id, 'El depósito')}::uuid AND company_id=${scope.companyId}::uuid FOR UPDATE`
    if (!d || d.payment_method_id !== methodId) fail(404, 'CASH_SETTLEMENT_DEPOSIT', 'Depósito no encontrado para este medio')
    return d
  }
  const reference = text(raw?.reference, 'La referencia del depósito', 120), depositedOn = day(raw?.depositedOn, 'La fecha del depósito'), total = exactMoney(raw?.totalAmount)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-deposit', scope.companyId, methodId, reference])},0))::text`
  const [old] = await tx.$queryRaw`SELECT * FROM cash_bank_deposits WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${methodId} AND reference=${reference} FOR UPDATE`
  if (old) {
    if (civil(old.deposited_on) !== depositedOn || !D(old.total_amount).eq(D(total))) fail(409, 'CASH_SETTLEMENT_DEPOSIT_MISMATCH', `El depósito ${reference} ya existe con otra fecha o total (${money(old.total_amount)}). Usa el registrado.`)
    return old
  }
  const [version] = await tx.$queryRaw`SELECT v.id FROM cash_bank_method_settings s JOIN cash_bank_method_versions v ON v.id=s.active_version_id
    WHERE s.company_id=${scope.companyId}::uuid AND s.payment_method_id=${methodId} AND v.mode='DEFERRED'`
  if (!version) fail(409, 'CASH_SETTLEMENT_DEPOSIT', 'El medio no tiene una configuración diferida aprobada.')
  const [row] = await guarded(() => tx.$queryRaw`INSERT INTO cash_bank_deposits(company_id,payment_method_id,version_id,reference,deposited_on,currency_code,total_amount,created_by_id)
    VALUES(${scope.companyId}::uuid,${methodId},${version.id}::uuid,${reference},${depositedOn}::date,(SELECT value FROM system_settings WHERE company_id=${scope.companyId}::uuid AND key='currency_code'),${total}::numeric,${scope.userId}::uuid) RETURNING *`)
  return row
}

// Recuperación sin resolver acredita fondos en disputa; la ya resuelta acredita las cuentas de sus lotes.
async function recoveryLines(tx, recoveries) {
  const lots = await require('./disputes.resolutions').recoveryLotAccounts(tx, recoveries.map(r => r.eventId)), lines = []
  for (const r of recoveries) {
    const mine = lots.filter(l => l.eventId === r.eventId), disposed = mine.reduce((s, l) => s.add(l.amount), D(0)), open = D(r.amount).sub(disposed)
    if (mine.some(l => !l.accountId)) fail(409, 'CASH_SETTLEMENT_ACCOUNTS', 'Con contabilidad activa, la resolución que recibe esta recuperación necesita sus cuentas configuradas.')
    if (open.gt(0)) lines.push({ account_id: r.accounting.disputeAccountId, debit: 0, credit: open.toNumber(), description: 'Recuperación de contracargo' })
    for (const l of mine) lines.push({ account_id: l.accountId, debit: 0, credit: l.amount.toNumber(), description: 'Recuperación de contracargo resuelto' })
  }
  return lines
}

async function createSettlement(tx, scope, raw = {}) {
  await requireAvailable(tx)
  const requestKey = id(raw.requestKey, 'La clave del intento'), methodId = Number(raw.paymentMethodId)
  if (!Number.isSafeInteger(methodId)) fail(400, 'CASH_SETTLEMENT_INPUT', 'Selecciona el medio')
  const net = exactMoney(raw.net)
  const allocations = (Array.isArray(raw.allocations) ? raw.allocations : []).map(a => ({ eventId: id(a?.eventId, 'El cobro'), amount: exactMoney(a?.amount) }))
  if (!allocations.length || new Set(allocations.map(a => a.eventId)).size !== allocations.length) fail(400, 'CASH_SETTLEMENT_INPUT', 'Selecciona al menos un cobro, una sola vez cada uno')
  const deductions = (Array.isArray(raw.deductions) ? raw.deductions : []).map(d => {
    if (!['FEE', 'CHARGEBACK', 'OTHER'].includes(d?.kind)) fail(400, 'CASH_SETTLEMENT_INPUT', 'Tipo de deducción inválido')
    if (d.kind === 'CHARGEBACK') id(d.eventId, 'El cobro del contracargo')
    return { kind: d.kind, amount: exactMoney(d.amount), description: text(d.description, 'La descripción de la deducción', 300), accountId: d.accountId == null || d.accountId === '' ? null : Number(d.accountId), eventId: d.eventId || null,
      disputeId: d.kind === 'CHARGEBACK' && d.disputeId != null ? id(d.disputeId, 'El expediente del contracargo').toLowerCase() : undefined }
  })
  // Recuperación del proveedor sumada a este depósito: neto = cobros − reembolsos − deducciones + recuperaciones.
  const recoveries = (Array.isArray(raw.recoveries) ? raw.recoveries : []).map(r => ({ disputeId: id(r?.disputeId, 'El expediente de la recuperación').toLowerCase(), amount: exactMoney(r?.amount) }))
  const hash = createHash('sha256').update(JSON.stringify({ methodId, net, deposit: raw.deposit, allocations, deductions, ...(recoveries.length ? { recoveries } : {}) })).digest('hex')
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['cash-settlement', scope.companyId, scope.branchId, scope.userId, requestKey])},0))::text`
  const [old] = await tx.$queryRaw`SELECT id,request_hash FROM cash_settlements WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid AND created_by_id=${scope.userId}::uuid AND request_key=${requestKey}::uuid`
  if (old) { if (old.request_hash !== hash) fail(409, 'CASH_SETTLEMENT_ATTEMPT_CONFLICT', 'Este intento corresponde a otra liquidación; recupera su resultado.'); return { replayed: true, settlement: await getSettlement(tx, scope, old.id) } }
  const disputes = await require('./disputes.queries').disputesAvailable(tx), linked = require('./disputes.settlements')
  // Solo los contracargos con expediente pasan por la ruta de disputas; los demás quedan como deducción histórica.
  const chargebacks = deductions.filter(d => d.kind === 'CHARGEBACK' && d.disputeId)
  // Con disputas cerradas, un contracargo sin expediente queda como deducción histórica que el expediente vincula después.
  const released = disputes && require('./disputes.release').commandsReleased()
  if (!released && (recoveries.length || chargebacks.length)) fail(409, 'CASH_SETTLEMENT_UNAVAILABLE', 'Las disputas todavía no están disponibles.')
  if (released && deductions.some(d => d.kind === 'CHARGEBACK' && !d.disputeId)) fail(409, 'CASH_SETTLEMENT_DISPUTE_REQUIRED', 'Un contracargo nuevo necesita su expediente de disputa. Regístralo antes de liquidar.')
  let cases = new Map()
  if (disputes) {
    const boundary = require('./disputes.boundary')
    const caseOrigins = await linked.settlementDisputeOrigins(tx, scope, [...chargebacks.map(d => d.disputeId), ...recoveries.map(r => r.disputeId)])
    await boundary.lockDisputeResources(tx, scope, await boundary.discoverDisputeResources(tx, scope, { eventIds: [...new Set([...allocations.map(a => a.eventId), ...deductions.map(d => d.eventId).filter(Boolean), ...caseOrigins])] }))
    cases = await linked.lockSettlementDisputes(tx, scope, { methodId, chargebacks, recoveries })
    for (const d of chargebacks) {
      if (d.accountId != null && d.accountId !== d.accounting.disputeAccountId) fail(409, 'CASH_SETTLEMENT_ACCOUNT', 'El contracargo usa la cuenta de fondos en disputa configurada; no se elige otra.')
      d.accountId = d.accounting.disputeAccountId
    }
  }
  // Cobros bloqueados en orden: dos liquidaciones simultáneas no se cruzan ni se exceden.
  const events = await tx.$queryRaw`SELECT e.id,e.direction,e.amount,e.branch_id,e.payment_method_id,e.company_id,m.mode,m.account_id,
    coalesce((SELECT sum(abs(a.amount)) FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=e.id AND s.status='POSTED'),0)
      + ${disputes ? Prisma.sql`cash_dispute_provider_withheld(e.id)` : Prisma.sql`0`} AS used
    FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id WHERE m.event_id=ANY(${allocations.map(a => a.eventId)}::uuid[]) ORDER BY m.event_id FOR UPDATE OF m`
  const byId = new Map(events.map(e => [e.id, e]))
  let gross = D(0), refunds = D(0)
  const signed = allocations.map(a => {
    const e = byId.get(a.eventId)
    if (!e || e.company_id !== scope.companyId || e.branch_id !== scope.branchId || e.payment_method_id !== methodId || e.mode !== 'DEFERRED')
      fail(409, 'CASH_SETTLEMENT_ALLOCATION', 'Un cobro seleccionado no está pendiente de liquidar en esta sucursal y medio.')
    if (D(a.amount).gt(D(e.amount).sub(D(e.used)))) fail(409, 'CASH_SETTLEMENT_ALLOCATION', 'Un cobro ya no tiene ese saldo pendiente. Recarga lo pendiente.')
    if (e.direction === 'IN') gross = gross.add(D(a.amount)); else refunds = refunds.add(D(a.amount))
    return { ...a, signed: e.direction === 'IN' ? D(a.amount) : D(a.amount).neg(), account: e.account_id }
  })
  const deducted = deductions.reduce((s, d) => s.add(D(d.amount)), D(0)), recovered = recoveries.reduce((s, r) => s.add(D(r.amount)), D(0))
  const expected = gross.sub(refunds).sub(deducted).add(recovered)
  if (!expected.eq(D(net))) fail(400, 'CASH_SETTLEMENT_BALANCE', `No cuadra: cobros ${gross.toFixed(2)} − reembolsos ${refunds.toFixed(2)} − deducciones ${deducted.toFixed(2)}${recovered.gt(0) ? ` + recuperaciones ${recovered.toFixed(2)}` : ''} = ${expected.toFixed(2)}, pero el neto es ${D(net).toFixed(2)}. Documenta la diferencia como deducción.`)
  const deposit = await resolveDeposit(tx, scope, methodId, raw.deposit)
  if ([...cases.values()].some(c => c.currencyCode !== deposit.currency_code)) fail(409, 'DISPUTE_INPUT_INVALID', 'Un expediente no está en la moneda de este depósito.')
  const settlementId = randomUUID()
  await guarded(() => disputes
    ? tx.$executeRaw`INSERT INTO cash_settlements(id,company_id,branch_id,deposit_id,currency_code,gross,refunds,deductions,recoveries,net,created_by_id,request_key,request_hash)
      VALUES(${settlementId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${deposit.id}::uuid,${deposit.currency_code},${gross.toFixed(2)}::numeric,${refunds.toFixed(2)}::numeric,${deducted.toFixed(2)}::numeric,${recovered.toFixed(2)}::numeric,${net}::numeric,${scope.userId}::uuid,${requestKey}::uuid,${hash})`
    : tx.$executeRaw`INSERT INTO cash_settlements(id,company_id,branch_id,deposit_id,currency_code,gross,refunds,deductions,net,created_by_id,request_key,request_hash)
      VALUES(${settlementId}::uuid,${scope.companyId}::uuid,${scope.branchId}::uuid,${deposit.id}::uuid,${deposit.currency_code},${gross.toFixed(2)}::numeric,${refunds.toFixed(2)}::numeric,${deducted.toFixed(2)}::numeric,${net}::numeric,${scope.userId}::uuid,${requestKey}::uuid,${hash})`)
  for (const a of signed) await guarded(() => tx.$executeRaw`INSERT INTO cash_settlement_allocations(settlement_id,event_id,amount) VALUES(${settlementId}::uuid,${a.eventId}::uuid,${a.signed.toFixed(2)}::numeric)`)
  const [version] = await tx.$queryRaw`SELECT * FROM cash_bank_method_versions WHERE id=${deposit.version_id}::uuid`
  for (const d of deductions) {
    d.accountId = d.accountId ?? (d.kind === 'FEE' ? version.fee_account_id : null)
    const [row] = await guarded(() => tx.$queryRaw`INSERT INTO cash_settlement_deductions(settlement_id,kind,amount,account_id,description,event_id) VALUES(${settlementId}::uuid,${d.kind},${d.amount}::numeric,${d.accountId},${d.description},${d.eventId}::uuid) RETURNING id`)
    d.id = row.id
  }
  await linked.recordSettlementDisputes(tx, scope, { settlementId, depositedOn: civil(deposit.deposited_on), reference: deposit.reference, bankAccountId: version.bank_account_id, docs: cases, chargebacks, recoveries })
  if (await accountingEnabled(tx, scope.companyId)) {
    // Banco por el neto, deducciones a su cuenta y la transitoria por cobros − reembolsos.
    const clearing = new Map()
    for (const a of signed) clearing.set(a.account, (clearing.get(a.account) || D(0)).add(a.signed))
    if (!version.bank_account_id || [...clearing.keys()].some(k => !k) || deductions.some(d => !d.accountId) || recoveries.some(r => !r.accounting.disputeAccountId))
      fail(409, 'CASH_SETTLEMENT_ACCOUNTS', 'Con contabilidad activa, el banco del medio, la transitoria, la cuenta de cada deducción y la de fondos en disputa deben estar configurados.')
    const lines = [{ account_id: version.bank_account_id, debit: D(net).toNumber(), credit: 0 },
      ...deductions.map(d => ({ account_id: d.accountId, debit: D(d.amount).toNumber(), credit: 0, description: d.description })),
      ...await recoveryLines(tx, recoveries),
      ...[...clearing].map(([account, amount]) => amount.gte(0) ? { account_id: account, debit: 0, credit: amount.toNumber() } : { account_id: account, debit: amount.neg().toNumber(), credit: 0 })]
    const entry = await require('../../services/accounting/core').createEntry(tx, { company_id: scope.companyId, branch_id: scope.branchId, date: new Date(civil(deposit.deposited_on) + 'T12:00:00Z'),
      description: `Liquidación ${deposit.reference}`.slice(0, 255), source_type: 'CASH_SETTLEMENT', source_id: settlementId, created_by: scope.userId, lines })
    await guarded(() => tx.$executeRaw`UPDATE cash_settlements SET journal_entry_id=${entry.id}::uuid WHERE id=${settlementId}::uuid`)
    // Sus efectos de disputa usan este mismo asiento; no se crea otro.
    if (cases.size) await tx.$executeRaw`UPDATE cash_dispute_events SET journal_entry_id=${entry.id}::uuid,accounting_status='INTEGRATED',accounting_on=${civil(deposit.deposited_on)}::date WHERE settlement_id=${settlementId}::uuid`
  }
  return { replayed: false, settlement: await getSettlement(tx, scope, settlementId) }
}

// Anular revierte el asiento una sola vez (fuente única) y libera las asignaciones; no se deshace.
async function voidSettlement(tx, scope, settlementId, raw = {}) {
  await requireAvailable(tx)
  const reason = text(raw.reason, 'El motivo de la anulación', 500)
  if(await require('./disputes.queries').disputesAvailable(tx)){
    const boundary=require('./disputes.boundary')
    await boundary.lockDisputeResources(tx,scope,await boundary.discoverDisputeResources(tx,scope,{settlementIds:[id(settlementId,'La liquidación')]}))
    const [linked]=await tx.$queryRaw`SELECT id FROM cash_dispute_events WHERE settlement_id=${settlementId}::uuid LIMIT 1`
    if(linked)fail(409,'CASH_SETTLEMENT_DISPUTE_DEPENDENCY','La liquidación respalda un contracargo. Revisa y compensa los movimientos vinculados desde su expediente antes de anularla.')
  }
  const [s] = await tx.$queryRaw`SELECT * FROM cash_settlements WHERE id::text=${String(settlementId)} AND company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid FOR UPDATE`
  if (!s) fail(404, 'CASH_SETTLEMENT_NOT_FOUND', 'Liquidación no encontrada')
  if (s.status === 'VOIDED') {
    if (s.void_reason === reason && s.voided_by_id === scope.userId) return { replayed: true, settlement: await getSettlement(tx, scope, s.id) }
    fail(409, 'CASH_SETTLEMENT_STATE', 'La liquidación ya fue anulada.')
  }
  await guarded(() => tx.$executeRaw`UPDATE cash_settlements SET status='VOIDED',void_reason=${reason},voided_by_id=${scope.userId}::uuid WHERE id=${s.id}::uuid`)
  if (s.journal_entry_id) {
    const core = require('../../services/accounting/core')
    const original = await tx.journalEntry.findUnique({ where: { id: s.journal_entry_id }, include: { lines: true } })
    const { year, month } = core.periodKeyForDate(original.date)
    const period = await tx.accountingPeriod.findFirst({ where: { company_id: scope.companyId, year, month } })
    const entry = await core.createEntry(tx, { company_id: scope.companyId, branch_id: s.branch_id, date: period?.status === 'CLOSED' ? new Date() : original.date,
      description: `Anulación de ${original.entry_number}: ${reason}`.slice(0, 255), source_type: 'CASH_SETTLEMENT', source_id: `void:${s.id}`, created_by: scope.userId, reversal_of_id: original.id,
      lines: original.lines.map(l => ({ account_id: l.account_id, debit: Number(l.credit), credit: Number(l.debit), description: l.description })) })
    await guarded(() => tx.$executeRaw`UPDATE cash_settlements SET void_entry_id=${entry.id}::uuid WHERE id=${s.id}::uuid`)
  }
  return { replayed: false, settlement: await getSettlement(tx, scope, s.id) }
}

async function getSettlement(db, scope, settlementId) {
  await requireAvailable(db)
  const [s] = await db.$queryRaw`SELECT s.*,d.reference AS deposit_reference,d.deposited_on,d.total_amount AS deposit_total,d.payment_method_id,pm.name AS payment_method_name,
    u.name AS created_by_name,vu.name AS voided_by_name,je.entry_number,ve.entry_number AS void_entry_number FROM cash_settlements s JOIN cash_bank_deposits d ON d.id=s.deposit_id
    JOIN payment_methods pm ON pm.id=d.payment_method_id JOIN users u ON u.id=s.created_by_id LEFT JOIN users vu ON vu.id=s.voided_by_id
    LEFT JOIN journal_entries je ON je.id=s.journal_entry_id LEFT JOIN journal_entries ve ON ve.id=s.void_entry_id
    WHERE s.id::text=${String(settlementId)} AND s.company_id=${scope.companyId}::uuid AND s.branch_id=${scope.branchId}::uuid`
  if (!s) fail(404, 'CASH_SETTLEMENT_NOT_FOUND', 'Liquidación no encontrada')
  const allocations = await db.$queryRaw`SELECT a.event_id,a.amount,e.source_type,e.economic_at,e.reference FROM cash_settlement_allocations a JOIN cash_money_events e ON e.id=a.event_id WHERE a.settlement_id=${s.id}::uuid ORDER BY e.economic_at`
  const disputes = await require('./disputes.queries').disputesAvailable(db)
  const deductions = disputes
    ? await db.$queryRaw`SELECT d.id,d.kind,d.amount,d.description,d.event_id,a.code||' · '||a.name AS account_label,e.dispute_id FROM cash_settlement_deductions d LEFT JOIN accounts a ON a.id=d.account_id
      LEFT JOIN cash_dispute_events e ON e.deduction_id=d.id WHERE d.settlement_id=${s.id}::uuid ORDER BY d.id`
    : await db.$queryRaw`SELECT d.id,d.kind,d.amount,d.description,d.event_id,a.code||' · '||a.name AS account_label FROM cash_settlement_deductions d LEFT JOIN accounts a ON a.id=d.account_id WHERE d.settlement_id=${s.id}::uuid ORDER BY d.id`
  const recoveries = disputes ? await db.$queryRaw`SELECT e.dispute_id,e.principal AS amount,p.provider_reference FROM cash_dispute_events e JOIN cash_payment_disputes p ON p.id=e.dispute_id
    WHERE e.settlement_id=${s.id}::uuid AND e.kind='PROVIDER_RECOVERY' ORDER BY e.created_at,e.id` : []
  return { ...s, request_hash: undefined, gross: money(s.gross), refunds: money(s.refunds), deductions_total: money(s.deductions), recoveries_total: money(s.recoveries ?? 0), net: money(s.net), deposit_total: money(s.deposit_total), deposited_on: civil(s.deposited_on),
    created_at: new Date(s.created_at).toISOString(), voided_at: s.voided_at ? new Date(s.voided_at).toISOString() : null,
    allocations: allocations.map(a => ({ ...a, amount: money(a.amount), economic_at: new Date(a.economic_at).toISOString() })), deductions: deductions.map(d => ({ ...d, amount: money(d.amount) })), recoveries: recoveries.map(r => ({ ...r, amount: money(r.amount) })) }
}

async function listSettlements(db, scope, query = {}) {
  await requireAvailable(db)
  const page = Math.max(1, Number(query.page) || 1), pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))
  const rows = await db.$queryRaw`SELECT s.id,s.status,s.net,s.gross,s.deductions,s.created_at,d.reference AS deposit_reference,d.deposited_on,pm.name AS payment_method_name FROM cash_settlements s
    JOIN cash_bank_deposits d ON d.id=s.deposit_id JOIN payment_methods pm ON pm.id=d.payment_method_id WHERE s.company_id=${scope.companyId}::uuid AND s.branch_id=${scope.branchId}::uuid
    ORDER BY s.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  const [{ total }] = await db.$queryRaw`SELECT count(*)::int AS total FROM cash_settlements WHERE company_id=${scope.companyId}::uuid AND branch_id=${scope.branchId}::uuid`
  return { items: rows.map(r => ({ ...r, net: money(r.net), gross: money(r.gross), deductions: money(r.deductions), deposited_on: civil(r.deposited_on), created_at: new Date(r.created_at).toISOString() })),
    totalItems: total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

// Cobros diferidos de la sucursal con saldo por liquidar (entradas positivas, reembolsos negativos).
async function pendingReceipts(db, scope, query = {}) {
  await requireAvailable(db)
  const disputes = await require('./disputes.queries').disputesAvailable(db)
  const method = query.paymentMethodId ? Number(query.paymentMethodId) : null
  const rows = await db.$queryRaw`SELECT e.id AS event_id,e.source_type,e.direction,e.amount,e.economic_at,e.reference,e.payment_method_id,pm.name AS payment_method_name,
    coalesce((SELECT sum(abs(a.amount)) FROM cash_settlement_allocations a JOIN cash_settlements s ON s.id=a.settlement_id WHERE a.event_id=e.id AND s.status='POSTED'),0)
      + ${disputes ? Prisma.sql`cash_dispute_provider_withheld(e.id)` : Prisma.sql`0`} AS used
    FROM cash_bank_event_modes m JOIN cash_money_events e ON e.id=m.event_id JOIN payment_methods pm ON pm.id=e.payment_method_id
    WHERE m.mode='DEFERRED' AND e.company_id=${scope.companyId}::uuid AND e.branch_id=${scope.branchId}::uuid ${method ? Prisma.sql`AND e.payment_method_id=${method}` : Prisma.empty}
    ORDER BY e.economic_at`
  const items = rows.map(r => ({ event_id: r.event_id, source_type: r.source_type, direction: r.direction, payment_method_id: r.payment_method_id, payment_method_name: r.payment_method_name,
    reference: r.reference, economic_at: new Date(r.economic_at).toISOString(), amount: money(r.amount), remaining: D(r.amount).sub(D(r.used)).toFixed(2) })).filter(i => D(i.remaining).gt(0))
  const totals = {}
  for (const i of items) totals[i.payment_method_id] = D(totals[i.payment_method_id] || 0).add(i.direction === 'IN' ? D(i.remaining) : D(i.remaining).neg()).toFixed(2)
  return { items, totals }
}

module.exports = { settlementsAvailable, createSettlement, voidSettlement, getSettlement, listSettlements, pendingReceipts, getDeposit, findDeposit }
