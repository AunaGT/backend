const { hasPerm } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
// Revisar arqueos reutiliza la autoridad de aprobar cierres; la política tiene permiso propio.
function reviewScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'CASH_ACTOR_REQUIRED', 'Inicia sesión para revisar arqueos')
  if (![req.companyId, req.branchId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  const isAdmin = isSystemAdmin(req.user.role), can = (...codes) => isAdmin || codes.some(code => hasPerm(req.user, code))
  const scope = { companyId: req.companyId, branchId: req.branchId, branchIds: [req.branchId], ...require('./readAccess').readCapabilities(req), userId: req.user.sub, userName: req.user.name || null, isAdmin,
    canReview: can('cashclosure.approve', 'cashclosure.validate'), canManagePolicy: can('cash.policies.manage'),
    canDeclare: can('cashclosure.create', 'cashclosure.create_own') }
  const allowed = { capabilities: true, review: scope.canReview, policy: scope.canManagePolicy, declare: scope.canDeclare }[action]
  if (!allowed) fail(403, 'CASH_REVIEW_FORBIDDEN', 'No tienes permiso para esta acción del arqueo')
  return scope
}
module.exports = { reviewScope }
