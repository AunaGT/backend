const { expandPermissions } = require('../config/permissionDeps')
const PASSWORD_CHANGE_REQUIRED = 'Cambio obligatorio de contraseña'
const hasActiveMembership = user => user.user_companies?.some(m => m.status === 'ACTIVE' && m.company?.active !== false)

function fail(status, message) { throw Object.assign(new Error(message), { status }) }
function permissions(role) {
  return expandPermissions((role?.permissions || []).map(p => p.permission?.code || p.code).filter(Boolean))
}
function effectiveUser(user, companyId) {
  const membership = companyId && user.user_companies?.find(m => m.company_id === companyId)
  if (companyId && (!membership || membership.status !== 'ACTIVE')) fail(403, 'Sin acceso activo a esa empresa')
  const role = membership?.role || user.role
  if (companyId && role?.company_id && role.company_id !== companyId) fail(403, 'Asigna un rol válido para esta empresa')
  return { ...user, active_company_id: companyId, sub: user.id, role, role_id: role?.id, role_name: role?.name, permissions: permissions(role) }
}
function assertGrant(actor, role) {
  if (actor.role?.name?.toLowerCase() === 'admin') return
  if (role.name?.toLowerCase() === 'admin' || permissions(role).some(p => !expandPermissions(actor.permissions || []).includes(p))) {
    fail(403, 'No puedes conceder permisos superiores a los tuyos')
  }
}
function listQuery(query = {}) {
  const page = Number(query.page ?? 1), pageSize = Number(query.pageSize ?? 20)
  const sort = query.sort || 'name', direction = query.direction || 'asc'
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !['name', 'email', 'created_at'].includes(sort) || !['asc', 'desc'].includes(direction)) fail(400, 'Paginación u orden no válidos')
  return { page, pageSize, orderBy: [{ [sort]: direction }, { id: 'asc' }] }
}
async function loadSessionUser(payload) {
  const { prisma } = require('../models/prisma')
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: {
    role: { include: { permissions: { include: { permission: true } } } },
    user_companies: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
  } })
  if (!user || (payload.auth_version || 0) !== user.auth_version) fail(401, 'La sesión ha caducado')
  if (!hasActiveMembership(user)) fail(403, 'Sin acceso activo a la plataforma')
  if (payload.sid && !await prisma.refreshToken.findFirst({ where: { user_id: user.id, session_id: payload.sid, revoked_at: null, expires_at: { gt: new Date() } }, select: { id: true } })) fail(401, 'Sesión cerrada')
  user.must_change_password = await requiresPasswordChange(user, prisma)
  return user
}
async function requiresPasswordChange(user, client) {
  if (user.password_changed_at) return false
  return Boolean(await client.userAccessEvent.findFirst({ where: { user_id: user.id, action: PASSWORD_CHANGE_REQUIRED }, select: { id: true } }))
}
module.exports = { effectiveUser, assertGrant, listQuery, permissions, fail, loadSessionUser, requiresPasswordChange, hasActiveMembership, PASSWORD_CHANGE_REQUIRED }
