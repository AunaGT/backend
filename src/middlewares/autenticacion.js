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
const { secret, ACCESS_COOKIE } = require('../config/security')
const { loadSessionUser, effectiveUser } = require('../services/userAccess')

exports.Auth = async function (req, res, next) {
  // Cookie httpOnly primero; fallback al header Bearer (curl/tests/herramientas).
  const cookieToken = req.cookies && req.cookies[ACCESS_COOKIE]
  const headerToken = req.headers.authorization
    ? req.headers.authorization.replace(/['"]+/g, '').replace('Bearer ', '')
    : null
  const token = cookieToken || headerToken

  if (!token) {
    return res.status(401).send({ message: 'No autenticado' })
  }

  try {
    const payload = jwt_simple.decode(token, secret)
    if (payload.exp <= moment().unix()) {
      return res.status(401).send({ message: 'El token ya ha expirado' })
    }
    const user = req.sessionUser || await loadSessionUser(payload)
    req.user = { ...effectiveUser(user, req.companyId), sid: payload.sid }
    next()
  } catch (error) {
    if (error.status) return res.status(error.status).send({ message: error.message })
    if (error.name === 'PrismaClientKnownRequestError' || error.name === 'PrismaClientInitializationError') return next(error)
    return res.status(401).send({ message: 'El token no es válido' })
  }
}

exports.isRole = function (roleName) {
  return (req, res, next) => {
    const user = req.user
    if (!user) return res.status(401).send({ message: 'No autenticado' })
    const tokenRoleName = user.role?.name || user.role_name
    const tokenRoleId = user.role?.id || user.role_id
    if (String(tokenRoleName) !== String(roleName) && String(tokenRoleId) !== String(roleName)) {
      return res.status(403).send({ message: 'No autorizado' })
    }
    next()
  }
}

exports.hasAnyRole = function (...roles) {
  const allowed = roles.map(String)
  return (req, res, next) => {
    const user = req.user
    if (!user) return res.status(401).send({ message: 'No autenticado' })
    const rname = user.role?.name || user.role_name || String(user.role_id)
    const rid = String(user.role?.id || user.role_id)
    // allow match by role name or by role id
    if (!allowed.includes(String(rname)) && !allowed.includes(rid)) {
      return res.status(403).send({ message: 'No autorizado' })
    }
    next()
  }
}

// Extraer permisos normalizados desde el token
function getUserPermissions(user) {
  if (!user) return []
  if (Array.isArray(user.permissions)) {
    return user.permissions.map((p) => String(p))
  }
  return []
}

// Verificar si el usuario es admin por nombre de rol
function isAdminUser(user) {
  const roleName = user?.role?.name || user?.role_name
  return typeof roleName === 'string' && roleName.toLowerCase() === 'admin'
}

/**
 * Middleware basado en permisos
 * Acepta uno o varios códigos de permiso y autoriza si el usuario tiene
 * AL MENOS UNO de ellos. Los administradores pasan siempre.
 */
exports.hasPermission = function (...permissionCodes) {
  const required = permissionCodes.map(String)

  return (req, res, next) => {
    const user = req.user
    if (!user) return res.status(401).send({ message: 'No autenticado' })

    // Admin siempre tiene acceso total
    if (isAdminUser(user)) {
      return next()
    }

    const userPerms = getUserPermissions(user)
    const hasAny = userPerms.some((code) => required.includes(code))

    if (!hasAny) {
      return res.status(403).send({ message: 'No autorizado' })
    }

    next()
  }
}
