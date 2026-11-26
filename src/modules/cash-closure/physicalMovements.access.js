const { hasPerm } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
function physicalMovementScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'CASH_ACTOR_REQUIRED', 'Inicia sesión para registrar efectivo')
  if (![req.companyId, req.branchId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  const isAdmin = isSystemAdmin(req.user.role)
  const can = code => isAdmin || hasPerm(req.user, 'cash.movements.' + code)
  const scope = { companyId: req.companyId, branchId: req.branchId, userId: req.user.sub, isAdmin,
    canViewOwn: can('view_own'), canViewTeam: can('view_team'), canCreateOwn: can('create_own'), canCreateTeam: can('create_team'), canCorrect: can('correct') }
  const allowed = action === 'capabilities' || action === 'view' && (scope.canViewOwn || scope.canViewTeam) || action === 'create' && (scope.canCreateOwn || scope.canCreateTeam) || action === 'correct' && scope.canCorrect
  if (!allowed) fail(403, 'CASH_MOVEMENT_FORBIDDEN', 'No tienes permiso para esta operación de efectivo')
  return scope
}
module.exports = { physicalMovementScope }
