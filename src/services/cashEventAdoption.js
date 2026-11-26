const { randomUUID } = require('node:crypto')
const { DateTime } = require('luxon')
const storage = require('../modules/cash-closure/eventStorage')
const { lockScopedRegister } = require('./cashSessionBoundary')
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
async function capabilities(tx, scope) {
  const available = await storage.ledgerAvailable(tx)
  return { money_events_available: available, can_adopt: available && scope.isAdmin === true && process.env.AUNA_CASH_MONEY_EVENTS_ADOPTION === '1' }
}
async function validateRegister(tx, scope, register) {
  // 4A: también una caja virtual individual, que registra solo cobros digitales.
  const shared = register.kind === 'PHYSICAL' && register.operation_mode === 'SHARED' && register.access_control_version === 1 && await require('./cashSharedSessions').available(tx)
  if (!['PHYSICAL', 'VIRTUAL'].includes(register.kind) || register.operation_mode !== 'INDIVIDUAL' && !shared || !/^[A-Z]{3}$/.test(register.currency_code || '')) fail(409, 'El registro de movimientos requiere moneda explícita y, para compartir, una caja física con accesos habilitados.')
  const currency = (await tx.systemSetting.findUnique({ where: { company_id_key: { company_id: scope.companyId, key: 'currency_code' } } }))?.value
  if (register.currency_code !== currency) fail(409, 'La moneda configurada de la caja debe coincidir con la empresa; no se convierte automáticamente.')
}
async function adoptRegister(tx, scope, id, input, { adoptionEnabled = process.env.AUNA_CASH_MONEY_EVENTS_ADOPTION === '1' } = {}) {
  if (scope.isAdmin !== true) fail(403, 'Solo el administrador del sistema puede habilitar este registro.')
  if (!adoptionEnabled || !await storage.ledgerAvailable(tx)) fail(409, 'La adopción de movimientos todavía no está habilitada.')
  if (input.eventVersion !== 1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail(400, 'Revisa la versión de configuración antes de habilitar.')
  const register = await lockScopedRegister(tx, scope, id)
  if (register.revision !== input.expectedRevision || register.money_event_version !== 0) fail(409, 'La caja cambió. Actualiza su configuración antes de continuar.')
  await validateRegister(tx, scope, register)
  if (await tx.cashRegisterSession.findFirst({ where: { cash_register_id: id, status: 'OPEN' }, select: { id: true } })) fail(409, 'Termina el turno actual antes de habilitar el registro. No se convertirá su historia.')
  const [updated] = await tx.$queryRaw`UPDATE cash_registers SET money_event_version=1,revision=revision+1 WHERE id=${id}::uuid AND revision=${input.expectedRevision} RETURNING *`
  if (!updated) fail(409, 'La configuración cambió. Actualiza e inténtalo de nuevo.')
  return updated
}
async function openEventSession(tx, scope, register, { openingFloat, notes, now = new Date() }) {
  if (Number(register.money_event_version || 0) === 0) return null
  if (register.money_event_version !== 1) fail(409, 'Versión del turno no disponible')
  // An adopted register is honored independently of the adoption feature flag.
  await validateRegister(tx, scope, register)
  const zone = await require('../utils/getTimezone').getTimezone(tx, scope.companyId)
  const date = DateTime.fromJSDate(now, { zone })
  if (!date.isValid) fail(409, 'Configura una zona horaria válida antes de abrir el turno.')
  // Take the same day gate before any opening writes; the SQL trigger also protects older/direct writers.
  const [{ available: dayGate }] = await tx.$queryRaw`SELECT to_regprocedure('cash_day_lock(uuid,uuid,date)') IS NOT NULL AS available`
  if (dayGate) {
    await tx.$queryRaw`SELECT cash_day_lock(${scope.companyId}::uuid,${scope.branchId}::uuid,${date.toISODate()}::date)::text`
    const [closed] = await tx.$queryRaw`SELECT d.finalized_at,u.name,b.name AS branch_name FROM cash_daily_consolidations d JOIN users u ON u.id=d.finalized_by_id JOIN branches b ON b.id=d.branch_id
      WHERE d.company_id=${scope.companyId}::uuid AND d.branch_id=${scope.branchId}::uuid AND d.business_date=${date.toISODate()}::date`
    if (closed) throw Object.assign(new Error(`El día operativo ${date.toISODate()} de ${closed.branch_name} ya fue finalizado por ${closed.name} el ${DateTime.fromJSDate(closed.finalized_at,{zone}).setLocale('es-GT').toFormat('dd LLL yyyy, HH:mm')}. No se pueden abrir más turnos con esa fecha. Un administrador debe revisar el cierre; la fecha no se cambia automáticamente.`),{status:409,code:'CASH_DAY_CLOSED'})
  }
  const { exactMoney } = require('../modules/receivables/paymentAttempts')
  const amount = exactMoney(openingFloat, { allowZero: true })
  if (register.kind === 'VIRTUAL' && amount !== '0.00') fail(409, 'Una caja virtual no tiene fondo inicial: solo registra cobros digitales.')
  let cashMethod = null
  if (amount !== '0.00') {
    await require('./paymentMethods/access').lockPaymentMethods(tx, scope.companyId)
    const choices = await require('./paymentMethods/access').listPaymentMethodChoices(tx, scope.companyId)
    cashMethod = choices.find(m => m.origin === 'BASIC' && m.settlement_kind === 'CASH') || choices.find(m => m.settlement_kind === 'CASH')
    if (!cashMethod) fail(409, 'Activa un medio clasificado como efectivo antes de declarar el fondo inicial.')
  }
  const [session] = await tx.$queryRaw`INSERT INTO cash_register_sessions(id,cash_register_id,opened_by_id,opening_float,notes,status,opened_at,updated_at,
    register_type,operation_mode,currency_code,business_date,business_timezone,money_event_version,opening_cash_method_id,opening_cash_method_name)
    VALUES(${randomUUID()}::uuid,${register.id}::uuid,${scope.userId}::uuid,${amount}::numeric,${notes},'OPEN',${now},${now},${register.kind}::"CashRegisterType",${register.operation_mode}::"CashRegisterOperationMode",${register.currency_code},${date.toISODate()}::date,${zone},1,${cashMethod?.id || null},${cashMethod?.name || null}) RETURNING *`
  // 3B.2: el fondo retenido entre turnos se hereda una sola vez; opening_float es lo que se contó al abrir.
  const inherited = register.kind === 'PHYSICAL' && await require('../modules/cash-closure/custody').inheritOpeningFloat(tx, scope, register, session)
  return inherited ? { ...session, opening_inherited_amount: inherited } : session
}
module.exports = { capabilities, adoptRegister, openEventSession }
