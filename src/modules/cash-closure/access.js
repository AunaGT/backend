const { hasPerm } = require('../../middlewares/tenant')

function closureScope(req, own) {
  if (!req.user?.sub) return { allowed: false, status: 401, message: 'No autenticado' }
  const allowed = hasPerm(req.user, 'cashclosure.create') || hasPerm(req.user, own ? 'cashclosure.create_own' : 'cashclosure.create_day')
  return allowed ? { allowed: true } : { allowed: false, status: 403, message: own ? 'No tiene permiso para generar su cierre' : 'No tiene permiso para generar cierre del día' }
}

module.exports = { closureScope }
