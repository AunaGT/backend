const { hasPerm } = require('../../middlewares/tenant')
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
function readCapabilities(req) {
  if (!req.user?.sub || req.integrationCredential || req.integration) fail(401, 'Inicia sesión para consultar arqueos')
  const viewTeam = ['cashclosure.view_team', 'cashclosure.approve', 'cashclosure.validate', 'cashclosure.correct'].some(code => hasPerm(req.user, code))
  return { viewOwn: viewTeam || hasPerm(req.user, 'cashclosure.view'), viewTeam }
}
function context(req) {
  readCapabilities(req)
  const branchIds = req.branchId ? [req.branchId] : req.branchIds
  if (![req.companyId, req.user.sub].every(v => typeof v === 'string' && uuid.test(v)) ||
      !Array.isArray(branchIds) || !branchIds.length || !branchIds.every(v => typeof v === 'string' && uuid.test(v)))
    fail(403, 'Selecciona una empresa y sucursal autorizadas')
  return { companyId: req.companyId, branchIds: [...new Set(branchIds)], userId: req.user.sub }
}
function readScope(req, requestedScope) {
  const capabilities = readCapabilities(req), actor = context(req)
  const mode = requestedScope === undefined ? (capabilities.viewTeam ? 'team' : 'mine') : requestedScope
  if (!['mine', 'team'].includes(mode)) fail(400, 'El alcance debe ser mine o team')
  if (!capabilities.viewOwn || mode === 'team' && !capabilities.viewTeam) fail(403, 'No tienes permiso para consultar estos arqueos')
  return { ...actor, mode, ...capabilities }
}
function lastDateScope(req, requestedScope) {
  const own = requestedScope === 'mine'
  const create = hasPerm(req.user, 'cashclosure.create') || hasPerm(req.user, own ? 'cashclosure.create_own' : 'cashclosure.create_day')
  if (create && (own || requestedScope === 'day')) return { ...context(req), mode: own ? 'mine' : 'team', viewOwn: true, viewTeam: !own }
  if (requestedScope === 'day') fail(403, 'No tienes permiso para preparar el cierre del día')
  return readScope(req, requestedScope)
}
module.exports = { readCapabilities, readScope, lastDateScope }
