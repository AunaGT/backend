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
// Solo lo que el servidor verifica: el token viaja en una cookie y los navegadores descartan
// en silencio las de más de 4096 bytes. Rol, permisos y datos personales se leen de la base
// en cada petición (loadSessionUser), así que llevarlos aquí solo hacía crecer la cookie.
exports.crearToken = function (usuario) {
  const payload = {
    sub: usuario.id,
    auth_version: usuario.auth_version || 0,
    ...(usuario.sid ? { sid: usuario.sid } : {}),
    iat: moment().unix(),
    exp: moment().add(ACCESS_TOKEN_MINUTES, 'minutes').unix(),
  }
  return jwt_simple.encode(payload, secret)
}
