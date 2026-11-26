const { hasPerm, requireBranch, requireCompany } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }) }
function cashRegisterAccess(req, action) {
  if (!req.user?.sub) fail(401, 'CASH_ACTOR_REQUIRED', 'Usuario no autenticado')
  const companyId = requireCompany(req), branchId = requireBranch(req)
  if (branchId === 'all') fail(400, 'CASH_BRANCH_REQUIRED', 'Selecciona una sucursal concreta')
  const authority = { view: 'cash.registers.view', manage: 'cash.registers.manage', 'legacy-manage': 'settings.manage' }[action]
  if (!authority || !hasPerm(req.user, authority)) fail(403, 'CASH_CONFIGURATION_FORBIDDEN', 'No tienes permiso para esta configuración de cajas')
  return { companyId, branchId, userId: req.user.sub, isAdmin: isSystemAdmin(req.user.role) }
}
async function hasExplicitRegisterAccess(tx, scope, registerId, version, userId) {
  if (Number(version || 0) !== 1) return true
  if (!userId) return false
  const rows = await tx.$queryRaw`SELECT a.id FROM cash_register_access a
    JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE'
    JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id
    WHERE a.company_id=${scope.companyId}::uuid AND a.branch_id=${scope.branchId}::uuid AND a.register_id=${registerId}::uuid
      AND a.user_id=${userId}::uuid AND a.active FOR SHARE OF a,uc,ub`
  return rows.length > 0
}
async function assertExplicitRegisterAccess(tx, scope, registerId, version, userId) {
  if (!await hasExplicitRegisterAccess(tx, scope, registerId, version, userId)) fail(403, 'CASH_REGISTER_ACCESS_DENIED', 'Esta persona ya no tiene acceso activo a la caja en esta sucursal')
}
module.exports = { cashRegisterAccess, hasExplicitRegisterAccess, assertExplicitRegisterAccess }
