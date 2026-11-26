const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// Sugerencia por medio base, nunca por el nombre: un medio personalizado no recibe sugerencia.
const SUGGESTED = { TRANSFER: 'DIRECT', CARD: 'DEFERRED' }

async function bankMethodsAvailable(db) {
  return (await db.$queryRaw`SELECT to_regclass('cash_bank_method_versions') IS NOT NULL AS ok`)[0]?.ok === true
}
async function requireAvailable(db) { if (!await bankMethodsAvailable(db)) fail(409, 'CASH_BANK_METHODS_UNAVAILABLE', 'La configuración de medios bancarios todavía no está disponible.') }
async function accountingEnabled(db, companyId) {
  const modules = require('../platform/registry').resolveEffectiveModules(await db.companyModule.findMany({ where: { company_id: companyId } }))
  return !!modules.find(m => m.code === 'accounting')?.effectiveEnabled
}
// Las guardas de la BD hablan en códigos; aquí se traducen.
async function guarded(work) {
  try { return await work() } catch (e) {
    const m = String(e?.message || '')
    if (/cash_bank_method_account/.test(m)) fail(409, 'CASH_BANK_METHOD_ACCOUNT', 'Las cuentas deben ser de la empresa, activas, de detalle y del tipo correcto (banco y transitoria: activo; comisión: gasto).')
    if (/cash_bank_method_kind/.test(m)) fail(409, 'CASH_BANK_METHOD_KIND', 'Solo se configuran medios digitales (bancarios) habilitados en la empresa.')
    if (/cash_bank_method_stale/.test(m)) fail(409, 'CASH_BANK_METHOD_STALE', 'La configuración vigente cambió desde que se hizo la propuesta. Prepara una nueva propuesta.')
    if (/cash_bank_method_one_proposal|cash_bank_method_state/.test(m)) fail(409, 'CASH_BANK_METHOD_STATE', 'La propuesta ya fue decidida o hay otra abierta. Recarga la configuración.')
    throw e
  }
}
const account = (value, label) => {
  if (value == null || value === '') return null
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) fail(400, 'CASH_BANK_METHOD_INPUT', `${label} no es válida`)
  return Number(value)
}
const versionSelect = id => require('@prisma/client').Prisma.sql`SELECT v.*,pu.name AS proposed_by_name,du.name AS decided_by_name,
  ba.code||' · '||ba.name AS bank_account_label,ca.code||' · '||ca.name AS clearing_account_label,fa.code||' · '||fa.name AS fee_account_label
  FROM cash_bank_method_versions v JOIN users pu ON pu.id=v.proposed_by_id LEFT JOIN users du ON du.id=v.decided_by_id
  LEFT JOIN accounts ba ON ba.id=v.bank_account_id LEFT JOIN accounts ca ON ca.id=v.clearing_account_id LEFT JOIN accounts fa ON fa.id=v.fee_account_id WHERE v.id=${id}::uuid`
const dto = v => v && ({ ...v, proposed_at: new Date(v.proposed_at).toISOString(), decided_at: v.decided_at ? new Date(v.decided_at).toISOString() : null })
async function readVersion(db, id) { const [v] = await db.$queryRaw(versionSelect(id)); return dto(v) || null }

async function listBankMethods(db, scope) {
  await requireAvailable(db)
  const rows = await db.$queryRaw`SELECT pm.id AS payment_method_id,pm.name,pm.base_code,s.active_version_id,
    (SELECT id FROM cash_bank_method_versions WHERE company_id=${scope.companyId}::uuid AND payment_method_id=pm.id AND status='PROPOSED') AS proposal_id
    FROM payment_methods pm JOIN company_payment_methods cp ON cp.payment_method_id=pm.id AND cp.company_id=${scope.companyId}::uuid AND cp.enabled
    LEFT JOIN cash_bank_method_settings s ON s.company_id=${scope.companyId}::uuid AND s.payment_method_id=pm.id
    WHERE pm.settlement_kind='BANK' AND NOT pm.is_credit AND (pm.company_id IS NULL OR pm.company_id=${scope.companyId}::uuid) ORDER BY cp.position,pm.name`
  const accounting = await accountingEnabled(db, scope.companyId)
  return Promise.all(rows.map(async r => ({ payment_method_id: r.payment_method_id, name: r.name, suggested_mode: SUGGESTED[r.base_code] || null, accounting,
    active: r.active_version_id ? await readVersion(db, r.active_version_id) : null, proposal: r.proposal_id ? await readVersion(db, r.proposal_id) : null })))
}

async function lockedVersion(tx, scope, id) {
  if (typeof id !== 'string' || !uuid.test(id)) fail(404, 'CASH_BANK_METHOD_NOT_FOUND', 'Propuesta no encontrada')
  const [v] = await tx.$queryRaw`SELECT * FROM cash_bank_method_versions WHERE id=${id}::uuid AND company_id=${scope.companyId}::uuid FOR UPDATE`
  if (!v) fail(404, 'CASH_BANK_METHOD_NOT_FOUND', 'Propuesta no encontrada')
  return v
}

// El gestor propone; la propuesta no clasifica ningún cobro hasta que el admin la aprueba.
async function proposeBankMethod(tx, scope, raw = {}) {
  await requireAvailable(tx)
  if (!scope.canManage && !scope.isAdmin) fail(403, 'CASH_BANK_METHOD_FORBIDDEN', 'No tienes permiso para configurar medios bancarios')
  const methodId = Number(raw.paymentMethodId), mode = raw.mode
  if (!Number.isSafeInteger(methodId)) fail(400, 'CASH_BANK_METHOD_INPUT', 'Selecciona el medio')
  if (!['DIRECT', 'DEFERRED'].includes(mode)) fail(400, 'CASH_BANK_METHOD_INPUT', 'Elige si el dinero llega directo al banco o lo liquida un proveedor')
  const label = typeof raw.destinationLabel === 'string' ? raw.destinationLabel.trim() : ''
  if (!label || label.length > 150) fail(400, 'CASH_BANK_METHOD_INPUT', 'Indica el destino (proveedor y cuenta) en hasta 150 caracteres')
  const accounts = { bank: account(raw.bankAccountId, 'La cuenta de banco'), clearing: mode === 'DEFERRED' ? account(raw.clearingAccountId, 'La cuenta transitoria') : null, fee: mode === 'DEFERRED' ? account(raw.feeAccountId, 'La cuenta de comisiones') : null }
  if (await accountingEnabled(tx, scope.companyId)) {
    const missing = [!accounts.bank && 'banco', mode === 'DEFERRED' && !accounts.clearing && 'cobros por liquidar', mode === 'DEFERRED' && !accounts.fee && 'comisiones'].filter(Boolean)
    if (missing.length) fail(400, 'CASH_BANK_METHOD_ACCOUNTS_REQUIRED', `Con contabilidad activa configura las cuentas de ${missing.join(', ')}.`)
  }
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-bank-method:' + scope.companyId + ':' + methodId},0))::text`
  const [state] = await tx.$queryRaw`SELECT (SELECT active_version_id FROM cash_bank_method_settings WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${methodId}) AS active,
    (SELECT coalesce(max(version),0)+1 FROM cash_bank_method_versions WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${methodId})::int AS next,
    EXISTS(SELECT 1 FROM cash_bank_method_versions WHERE company_id=${scope.companyId}::uuid AND payment_method_id=${methodId} AND status='PROPOSED') AS open`
  if (state.open) fail(409, 'CASH_BANK_METHOD_STATE', 'Ya hay una propuesta abierta para este medio. Retírala o espera la decisión del administrador.')
  const [row] = await guarded(() => tx.$queryRaw`INSERT INTO cash_bank_method_versions(company_id,payment_method_id,version,mode,destination_label,bank_account_id,clearing_account_id,fee_account_id,base_version_id,proposed_by_id)
    VALUES(${scope.companyId}::uuid,${methodId},${state.next},${mode},${label},${accounts.bank},${accounts.clearing},${accounts.fee},${state.active}::uuid,${scope.userId}::uuid) RETURNING id`)
  return { version: await readVersion(tx, row.id) }
}

// Solo el admin pone una versión en vigor; la anterior queda reemplazada y sus cobros conservan su clasificación.
async function approveBankMethod(tx, scope, id) {
  await requireAvailable(tx)
  if (!scope.isAdmin) fail(403, 'CASH_BANK_METHOD_ADMIN', 'Solo el administrador aprueba la configuración de un medio bancario')
  const v = await lockedVersion(tx, scope, id)
  await guarded(() => tx.$executeRaw`UPDATE cash_bank_method_versions SET status='APPROVED',decided_by_id=${scope.userId}::uuid WHERE id=${v.id}::uuid`)
  if (v.base_version_id) await tx.$executeRaw`UPDATE cash_bank_method_versions SET status='SUPERSEDED' WHERE id=${v.base_version_id}::uuid AND status='APPROVED'`
  await tx.$executeRaw`INSERT INTO cash_bank_method_settings(company_id,payment_method_id,active_version_id) VALUES(${scope.companyId}::uuid,${v.payment_method_id},${v.id}::uuid)
    ON CONFLICT(company_id,payment_method_id) DO UPDATE SET active_version_id=EXCLUDED.active_version_id`
  return { version: await readVersion(tx, v.id) }
}
async function rejectBankMethod(tx, scope, id, raw = {}) {
  await requireAvailable(tx)
  if (!scope.isAdmin) fail(403, 'CASH_BANK_METHOD_ADMIN', 'Solo el administrador decide sobre la configuración de un medio bancario')
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  if (!reason || reason.length > 500) fail(400, 'CASH_BANK_METHOD_INPUT', 'Indica el motivo del rechazo en hasta 500 caracteres')
  const v = await lockedVersion(tx, scope, id)
  await guarded(() => tx.$executeRaw`UPDATE cash_bank_method_versions SET status='REJECTED',decided_by_id=${scope.userId}::uuid,decision_reason=${reason} WHERE id=${v.id}::uuid`)
  return { version: await readVersion(tx, v.id) }
}
async function withdrawProposal(tx, scope, id) {
  await requireAvailable(tx)
  const v = await lockedVersion(tx, scope, id)
  if (!scope.isAdmin && v.proposed_by_id !== scope.userId) fail(403, 'CASH_BANK_METHOD_FORBIDDEN', 'Solo quien la propuso o el administrador puede retirarla')
  await guarded(() => tx.$executeRaw`UPDATE cash_bank_method_versions SET status='WITHDRAWN' WHERE id=${v.id}::uuid`)
  return { version: await readVersion(tx, v.id) }
}

// Cuentas elegibles sin pedir permiso de contabilidad: solo activos y gastos de detalle activos de la empresa.
async function bankMethodAccounts(db, scope) {
  const rows = await db.$queryRaw`SELECT id,code,name,type::text AS type FROM accounts WHERE company_id=${scope.companyId}::uuid AND active AND NOT is_group AND type::text IN('ASSET','EXPENSE') ORDER BY code`
  return { assets: rows.filter(r => r.type === 'ASSET'), expenses: rows.filter(r => r.type === 'EXPENSE') }
}
module.exports = { bankMethodAccounts, bankMethodsAvailable, accountingEnabled, listBankMethods, proposeBankMethod, approveBankMethod, rejectBankMethod, withdrawProposal }
