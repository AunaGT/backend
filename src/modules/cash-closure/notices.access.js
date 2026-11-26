const { hasPerm } = require('../../middlewares/tenant')
const { isSystemAdmin } = require('../users/roles/policy')
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }) }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Avisos de pago (4A): solo personal autenticado de Auna; una credencial de integración nunca registra ni confirma.
function noticeScope(req, action) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'CASH_ACTOR_REQUIRED', 'Inicia sesión para gestionar avisos de pago')
  if (![req.companyId, req.branchId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v))) fail(403, 'CASH_SCOPE_REQUIRED', 'Selecciona una empresa y sucursal')
  const isAdmin = isSystemAdmin(req.user.role), can = code => isAdmin || hasPerm(req.user, code)
  // Confirmar crea un cobro de cartera: exige también esa autoridad.
  const canConfirm = can('cash.digital.confirm') && can('receivables.manage')
  const scope = { companyId: req.companyId, branchId: req.branchId, userId: req.user.sub, userName: req.user.name || null, isAdmin,
    canCreate: can('cash.notices.create'), canConfirm, canView: can('cash.notices.create') || can('cash.digital.confirm') }
  const allowed = { capabilities: true, view: scope.canView, create: scope.canCreate, confirm: scope.canConfirm }[action]
  if (!allowed) fail(403, 'CASH_NOTICE_FORBIDDEN', 'No tienes permiso para esta acción de avisos de pago')
  return scope
}
module.exports = { noticeScope }
