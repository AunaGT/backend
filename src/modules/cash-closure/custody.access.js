const { hasPerm } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
// Autoridad propia de custodia y traslados: no se deriva de ventas, configuración ni movimientos físicos.
function custodyScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'CASH_ACTOR_REQUIRED', 'Inicia sesión para mover efectivo')
  if (![req.companyId, req.branchId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  const isAdmin = isSystemAdmin(req.user.role), can = code => isAdmin || hasPerm(req.user, code)
  const scope = { companyId: req.companyId, branchId: req.branchId, userId: req.user.sub, isAdmin,
    canView: can('cash.custody.view'), canManage: can('cash.custody.manage'), canOperateOwn: can('cash.transfers.operate_own'),
    canOperateTeam: can('cash.transfers.operate_team'), canReceive: can('cash.transfers.receive') }
  const allowed = { capabilities: true, view: scope.canView || scope.canOperateOwn || scope.canOperateTeam || scope.canReceive || scope.canManage,
    send: scope.canOperateOwn || scope.canOperateTeam, receive: scope.canReceive, manage: scope.canManage }[action]
  if (!allowed) fail(403, 'CASH_CUSTODY_FORBIDDEN', 'No tienes permiso para esta operación de efectivo')
  return scope
}
module.exports = { custodyScope }
