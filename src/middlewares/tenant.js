/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Resolución de tenant (empresa + sucursal) por request.
 *
 * Se monta una sola vez en routes/index.js, antes de las rutas. Lee los
 * headers X-Company-Id / X-Branch-Id, los valida contra las membresías del
 * usuario (user_branches) y deja:
 *   req.companyId  – empresa del request (siempre presente si hay sesión)
 *   req.branchId   – sucursal del request (null solo en vista consolidada)
 *   req.branchIds  – solo en vista consolidada: todas las sucursales de la empresa
 *
 * Sin header X-Branch-Id se usa la sucursal por defecto del usuario (o su
 * única sucursal), así los clientes viejos siguen funcionando sin cambios.
 *
 * `X-Branch-Id: all` = vista consolidada de la empresa. Solo GET y solo con
 * permiso `branches.view_all` (o admin).
 */

const jwt_simple = require('jwt-simple')
const moment = require('moment')
const { secret, ACCESS_COOKIE } = require('../config/security')
const { prisma } = require('../models/prisma')
const { loadSessionUser, effectiveUser } = require('../services/userAccess')

// Igual que Auth pero sin responder 401: las rutas públicas y Auth se encargan.
function decodeUser(req) {
  const cookieToken = req.cookies && req.cookies[ACCESS_COOKIE]
  const headerToken = req.headers.authorization
    ? req.headers.authorization.replace(/['"]+/g, '').replace('Bearer ', '')
    : null
  const token = cookieToken || headerToken
  if (!token) return null
  try {
    const payload = jwt_simple.decode(token, secret)
    if (payload.exp <= moment().unix()) return null
    return payload
  } catch {
    return null
  }
}

function isAdmin(user) {
  const roleName = user?.role?.name || user?.role_name
  return typeof roleName === 'string' && roleName.toLowerCase() === 'admin'
}

function hasPerm(user, code) {
  return isAdmin(user) || (Array.isArray(user?.permissions) && user.permissions.includes(code))
}

async function resolveTenant(req, res, next) {
  try {
    // Renovar o cerrar una sesión no depende de que su access token siga vigente.
    if (/^\/auth\/(login|refresh|logout)$/.test(req.path)) return next()
    // Rutas de auth (login/refresh/me y gestión de usuarios): resolución en modo
    // suave — si se puede, se resuelve (para crear usuarios con empresa); si no,
    // se sigue sin tenant en vez de bloquear el login o /me.
    const soft = /^\/auth\/(login|refresh|logout|me)(\/|$)/.test(req.path)
    const fail = (status, message) => {
      if (soft) return next()
      return res.status(status).json({ message })
    }

    const user = decodeUser(req)
    if (!user) return next()
    // Sesión y permisos frescos, antes de comprobar acceso consolidado.
    let sessionUser
    try {
      sessionUser = await loadSessionUser(user)
    } catch (err) {
      if (soft) return next()
      return res.status(err.status || 401).json({ message: err.message })
    }
    req.sessionUser = sessionUser
    const activeCompanies = sessionUser.user_companies.filter(m => m.status === 'ACTIVE').map(m => m.company_id)
    const requestedCompany = req.headers['x-company-id']
    if (requestedCompany && !activeCompanies.includes(requestedCompany)) return fail(403, 'Sin acceso activo a esa empresa')
    req.user = effectiveUser(sessionUser, requestedCompany || undefined)

    // ponytail: 1 query por request; cache por usuario si algún día pesa
    const row = await prisma.user.findUnique({
      where: { id: user.sub },
      select: {
        default_branch_id: true,
        user_branches: {
          select: {
            branch: { select: { id: true, company_id: true, active: true, is_default: true } },
          },
        },
      },
    })
    if (!row) return fail(401, 'No autenticado')

    const branches = row.user_branches.map((m) => m.branch).filter((b) => b.active && activeCompanies.includes(b.company_id))
    if (branches.length === 0) {
      return fail(403, 'No tienes ninguna sucursal asignada')
    }

    const headerBranch = req.headers['x-branch-id'] || null
    const headerCompany = req.headers['x-company-id'] || null

    // Vista consolidada: toda la empresa, solo lectura.
    if (headerBranch === 'all') {
      if (req.method !== 'GET') {
        return res.status(400).json({ message: 'La vista consolidada es solo de lectura: indica una sucursal' })
      }
      const companyId = headerCompany || branches[0].company_id
      req.user = effectiveUser(sessionUser, companyId)
      if (!hasPerm(req.user, 'branches.view_all')) {
        return res.status(403).json({ message: 'No autorizado para la vista consolidada' })
      }
      if (!branches.some((b) => b.company_id === companyId)) {
        return res.status(403).json({ message: 'Sin acceso a esa empresa' })
      }
      const companyBranches = await prisma.branch.findMany({
        where: { company_id: companyId },
        select: { id: true },
      })
      req.companyId = companyId
      req.branchId = null
      req.branchIds = companyBranches.map((b) => b.id)
      return next()
    }

    let branch = null
    if (headerBranch) {
      branch = branches.find((b) => b.id === headerBranch)
      if (!branch) return fail(403, 'Sin acceso a esa sucursal')
    } else if (row.default_branch_id) {
      branch = branches.find((b) => b.id === row.default_branch_id)
    }
    if (!branch && branches.length === 1) branch = branches[0]
    if (!branch) branch = branches.find((b) => b.is_default)
    if (!branch) {
      return fail(400, 'Selecciona una sucursal (header X-Branch-Id)')
    }
    if (headerCompany && headerCompany !== branch.company_id) {
      // Con sucursal explícita el desajuste es un error del cliente. Sin ella la
      // heredada es de otra empresa (acaba de cambiarse): se usa la suya en la
      // empresa pedida, si no /configuracion mostraría los datos de la anterior.
      if (headerBranch) return fail(400, 'La sucursal no pertenece a esa empresa')
      const enEmpresa = branches.filter((b) => b.company_id === headerCompany)
      const alterna = enEmpresa.find((b) => b.is_default) || enEmpresa[0]
      if (!alterna) return fail(403, 'Sin acceso a esa empresa')
      branch = alterna
    }

    req.companyId = branch.company_id
    req.user = effectiveUser(sessionUser, req.companyId)
    req.branchId = branch.id
    // Sucursales del usuario en esta empresa: para escrituras dirigidas a otra
    // sucursal (crear un pedido "de Zona 11" estando parado en Zona 10).
    req.userBranchIds = branches.filter((b) => b.company_id === branch.company_id).map((b) => b.id)
    next()
  } catch (e) {
    next(e)
  }
}

/** Guard para controllers que exigen sucursal concreta (escrituras). */
function requireBranch(req) {
  if (!req.branchId) {
    const err = new Error('Esta operación requiere una sucursal concreta')
    err.status = 400
    throw err
  }
  return req.branchId
}

/**
 * Guard para las rutas /auth/*, donde la resolución es suave y companyId puede
 * venir vacío: un filtro `company_id: undefined` en Prisma NO filtra nada.
 */
function requireCompany(req) {
  if (!req.companyId) {
    const err = new Error('Selecciona una empresa (header X-Company-Id)')
    err.status = 400
    throw err
  }
  return req.companyId
}

/** Sucursal explícita del body (debe ser del usuario) o la activa. */
function targetBranch(req, raw) {
  if (raw == null || String(raw).trim() === '') return requireBranch(req)
  const id = String(raw).trim()
  if (!(req.userBranchIds || []).includes(id)) {
    const err = new Error('Sin acceso a esa sucursal')
    err.status = 403
    throw err
  }
  return id
}

/** Where de sucursal: una concreta o todas las de la empresa (consolidada). */
function branchWhere(req) {
  return req.branchId ? { branch_id: req.branchId } : { branch_id: { in: req.branchIds || [] } }
}

module.exports = { resolveTenant, requireBranch, requireCompany, targetBranch, branchWhere, hasPerm }
