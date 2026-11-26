const { fail } = require('./errors')
const permissions = Object.freeze([
  { code: 'fiscal.view', name: 'Ver conectores fiscales', description: 'Consulta la configuración y actividad fiscal, sin acceso a secretos' },
  { code: 'fiscal.manage', name: 'Configurar conectores fiscales', description: 'Guarda y reemplaza credenciales cifradas; no activa emisiones' },
  { code: 'fiscal.test', name: 'Revisar conexión fiscal', description: 'Ejecuta revisiones locales; no autoriza pruebas externas' },
  { code: 'fiscal.activate', name: 'Activar facturación real', description: 'Permiso reservado: la activación externa permanece deshabilitada' },
  { code: 'fiscal.retry', name: 'Recuperar operaciones fiscales', description: 'Permiso reservado para conciliación de operaciones, no un nuevo cobro' },
  { code: 'fiscal.cancel', name: 'Solicitar anulación fiscal', description: 'Permiso reservado para anulaciones; no cancela ventas ni pagos' },
  { code: 'fiscal.download', name: 'Descargar documentos fiscales', description: 'Permiso reservado para descargar documentos fiscales de sucursales autorizadas' },
])
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
function authorize(scope, action = 'view') {
  if (!uuid.test(scope?.companyId || '') || !uuid.test(scope?.actorId || '')) throw fail(400, 'FISCAL_SCOPE_REQUIRED', 'Selecciona una empresa y una sesión válidas')
  const allowed = scope.permissions || []
  const canView = action === 'view' && ['fiscal.manage', 'fiscal.test', 'fiscal.activate', 'fiscal.retry', 'fiscal.cancel', 'fiscal.download'].some(p => allowed.includes(p))
  if (!scope.isAdmin && !allowed.includes(`fiscal.${action}`) && !canView) throw fail(403, 'FISCAL_FORBIDDEN', 'No tienes permiso para esta acción fiscal')
  return { ...scope, companyId: scope.companyId.toLowerCase(), actorId: scope.actorId.toLowerCase() }
}
module.exports = { permissions, authorize }
