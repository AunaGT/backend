const { Prisma } = require('@prisma/client')
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
function bounds(scope) {
  if (!scope.viewOwn || scope.mode === 'team' && !scope.viewTeam) fail(403, 'No tienes permiso para consultar estos arqueos')
  return Prisma.sql`b.company_id=${scope.companyId}::uuid AND c.branch_id=ANY(${scope.branchIds}::uuid[])`
}
async function ownSession(db, scope) {
  const participants = await require('../../services/cashSharedSessions').available(db)
  return Prisma.sql`(s.opened_by_id=${scope.userId}::uuid ${participants ? Prisma.sql`OR EXISTS(SELECT 1 FROM cash_session_participants p WHERE p.session_id=s.id AND p.user_id=${scope.userId}::uuid)` : Prisma.empty})`
}
async function readable(db, scope) {
  const tenant = bounds(scope)
  if (scope.mode === 'team') return Prisma.sql`WITH readable AS (SELECT c.* FROM cash_closures c JOIN branches b ON b.id=c.branch_id WHERE ${tenant})`
  const own = await ownSession(db, scope)
  // UNION deduplicates the persisted chain, so even a damaged cycle terminates.
  return Prisma.sql`WITH RECURSIVE scoped AS (SELECT c.* FROM cash_closures c JOIN branches b ON b.id=c.branch_id WHERE ${tenant}),
    session_closures AS (
      SELECT c.id,c.branch_id,(to_jsonb(c)->>'supersedes_closure_id')::uuid AS previous_id FROM scoped c
      JOIN cash_register_sessions s ON s.cash_closure_id=c.id JOIN cash_registers r ON r.id=s.cash_register_id AND r.branch_id=c.branch_id
      WHERE ${own}
      UNION
      SELECT p.id,p.branch_id,(to_jsonb(p)->>'supersedes_closure_id')::uuid FROM scoped p JOIN session_closures h ON h.previous_id=p.id AND h.branch_id=p.branch_id
    ), readable AS (SELECT c.* FROM scoped c WHERE c.cashier_id=${scope.userId}::uuid OR EXISTS(SELECT 1 FROM session_closures h WHERE h.id=c.id))`
}
function filters(input, timeZone) {
  const page = input.page === undefined ? 1 : Number(input.page), pageSize = input.pageSize === undefined ? 20 : Number(input.pageSize)
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) fail(400, 'La paginación no es válida')
  const { DateTime } = require('luxon')
  const dates = [input.startDate, input.endDate].map((v, index) => {
    if (v === undefined || v === '') return null
    if (typeof v !== 'string') return new Date(NaN)
    let date = DateTime.fromISO(v, { zone: timeZone })
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) date = index ? date.endOf('day') : date.startOf('day')
    return date.toJSDate()
  })
  if (dates.some(d => d && !Number.isFinite(+d)) || dates[0] && dates[1] && dates[0] > dates[1]) fail(400, 'El período no es válido')
  if (input.status !== undefined && typeof input.status !== 'string') fail(400, 'El estado no es válido')
  const terms = [Prisma.sql`true`]
  if (input.status) terms.push(Prisma.sql`status=${input.status}`)
  if (dates[0]) terms.push(Prisma.sql`date>=${dates[0]}`)
  if (dates[1]) terms.push(Prisma.sql`date<=${dates[1]}`)
  return { page, pageSize, where: Prisma.join(terms, ' AND ') }
}
async function readPage(db, scope, input = {}) {
  const timeZone = input.startDate || input.endDate ? await require('../../utils/getTimezone').getTimezone(db, scope.companyId) : 'UTC'
  const { page, pageSize, where } = filters(input, timeZone)
  return db.$transaction(async tx => {
    const cte = await readable(tx, scope)
    const groups = await tx.$queryRaw`${cte} SELECT status,count(*)::int AS count FROM readable WHERE ${where} GROUP BY status`
    const totalItems = groups.reduce((n, r) => n + r.count, 0), totalPages = Math.max(1, Math.ceil(totalItems / pageSize)), safePage = Math.min(page, totalPages)
    const rows = await tx.$queryRaw`${cte} SELECT id FROM readable WHERE ${where} ORDER BY date DESC,id DESC OFFSET ${(safePage-1)*pageSize} LIMIT ${pageSize}`
    return { ids: rows.map(r => r.id), page: safePage, pageSize, totalItems, totalPages,
      ...(input.includeSummary ? { summary: { total: totalItems, Pendiente: 0, Aprobado: 0, Rechazado: 0, Validado: 0, Cerrado: 0, ...Object.fromEntries(groups.map(r => [r.status, r.count])) } } : {}) }
  }, { isolationLevel: 'RepeatableRead' })
}
async function assertReadable(db, scope, id) {
  if (typeof id !== 'string' || !uuid.test(id)) fail(404, 'Cierre de caja no encontrado')
  const cte = await readable(db, scope)
  const rows = await db.$queryRaw`${cte} SELECT id FROM readable WHERE id=${id}::uuid`
  if (!rows.length) fail(404, 'Cierre de caja no encontrado')
}
async function canReadSession(db, scope, sessionId) {
  if (typeof sessionId !== 'string' || !uuid.test(sessionId)) return false
  const own = await ownSession(db, scope)
  const [row] = await db.$queryRaw`SELECT EXISTS(SELECT 1 FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id
    WHERE s.id=${sessionId}::uuid AND b.company_id=${scope.companyId}::uuid AND r.branch_id=ANY(${scope.branchIds}::uuid[]) AND (${scope.viewTeam === true} OR ${own})) AS allowed`
  return row.allowed
}
async function lastClosure(db, scope) {
  const cte = await readable(db, scope)
  const [row] = await db.$queryRaw`${cte} SELECT end_date,closure_number FROM readable ORDER BY end_date DESC,id DESC LIMIT 1`
  return row || null
}
module.exports = { readPage, assertReadable, canReadSession, lastClosure }
