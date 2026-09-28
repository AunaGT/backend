/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const jwt_simple = require('jwt-simple')
const moment = require('moment')
const { secret, ACCESS_TOKEN_MINUTES } = require('../config/security')
const { expandPermissions } = require('../config/permissionDeps')

exports.crearToken = function (usuario) {
  // prefer a full role object when available, otherwise fallback to role_id/role_name
  const roleObj = usuario.role
    ? { id: usuario.role.id, name: usuario.role.name }
    : usuario.role_id
    ? { id: usuario.role_id, name: usuario.role_name || null }
    : null

  // Intentar extraer permisos del objeto de usuario si vienen incluidos
  let permissions = []
  if (usuario.role && Array.isArray(usuario.role.permissions)) {
    permissions = usuario.role.permissions
      .map((rp) => rp.permission && rp.permission.code)
      .filter(Boolean)
  } else if (Array.isArray(usuario.permissions)) {
    permissions = usuario.permissions
  }

  // El token lleva los permisos ya expandidos: quien puede editar puede ver,
  // sin que cada middleware tenga que acordarse de la dependencia.
  permissions = expandPermissions(permissions)

  const payload = {
    sub: usuario.id,
    name: usuario.name,
    email: usuario.email,
    role_id: usuario.role_id,
    role_name: usuario.role?.name || usuario.role_name || null,
    role: roleObj,
    permissions,
    auth_version: usuario.auth_version || 0,
    ...(usuario.sid ? { sid: usuario.sid } : {}),
    iat: moment().unix(),
    exp: moment().add(ACCESS_TOKEN_MINUTES, 'minutes').unix(),
  }
  return jwt_simple.encode(payload, secret)
}
