const { hasPerm } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// 4B: proponer medios y liquidar son autoridades separadas. Aprobar un medio es solo del admin canónico.
function settlementScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'CASH_ACTOR_REQUIRED', 'Inicia sesión para gestionar medios bancarios y liquidaciones')
  if (![req.companyId, req.branchId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  const isAdmin = isSystemAdmin(req.user.role), can = code => isAdmin || hasPerm(req.user, code)
  const scope = { companyId: req.companyId, branchId: req.branchId, userId: req.user.sub, userName: req.user.name || null, isAdmin,
    canManage: can('cash.bank_methods.manage'), canSettle: can('cash.settlements.manage'),
    // Contracargos y recuperaciones dentro de una liquidación son movimientos de disputa.
    canDisputeMovements: can('cash.disputes.movements') }
  const allowed = { capabilities: true, methods: scope.canManage, settlements: scope.canSettle }[action]
  if (!allowed) fail(403, 'CASH_SETTLEMENT_FORBIDDEN', 'No tienes permiso para esta acción de medios bancarios o liquidaciones')
  return scope
}
module.exports = { settlementScope }
