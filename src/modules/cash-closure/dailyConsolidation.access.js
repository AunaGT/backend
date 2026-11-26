const { hasPerm } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// 5: finalizar el día es su propia autoridad; quien revisa arqueos puede leer la consolidación pero no finalizarla.
function dailyScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'CASH_ACTOR_REQUIRED', 'Inicia sesión para revisar el día de caja')
  if (![req.companyId, req.branchId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  const isAdmin = isSystemAdmin(req.user.role), can = (...codes) => isAdmin || codes.some(code => hasPerm(req.user, code))
  const scope = { companyId: req.companyId, branchId: req.branchId, userId: req.user.sub, userName: req.user.name || null, isAdmin,
    canFinalize: can('cash.day.close'), canView: can('cash.day.close', 'cashclosure.approve', 'cashclosure.validate') }
  if (!{ view: scope.canView, finalize: scope.canFinalize }[action]) fail(403, 'CASH_DAY_FORBIDDEN', 'No tienes permiso para esta acción del cierre del día')
  return scope
}
module.exports = { dailyScope }
