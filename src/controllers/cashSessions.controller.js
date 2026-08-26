/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../models/prisma')

const number = (v) => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function isAdminUser (user) {
  return String(user?.role?.name || user?.role_name || '').toLowerCase() === 'admin'
}

function getPerms (req) {
  return Array.isArray(req.user?.permissions) ? req.user.permissions.map(String) : []
}

function checkCanReadCashSession (req) {
  const user = req.user
  if (!user) return { allowed: false, status: 401, message: 'No autenticado' }
  if (isAdminUser(user)) return { allowed: true }
  const perms = getPerms(req)
  const has =
    perms.includes('sales.create') ||
    perms.includes('cashclosure.view') ||
    perms.includes('cashclosure.create') ||
    perms.includes('cashclosure.create_day') ||
    perms.includes('cashclosure.create_own')
  return has ? { allowed: true } : { allowed: false, status: 403, message: 'No autorizado' }
}

/** Abrir / cerrar turno (no basta con solo «ver» cierres). */
function checkCanMutateCashSession (req) {
  const user = req.user
  if (!user) return { allowed: false, status: 401, message: 'No autenticado' }
  if (isAdminUser(user)) return { allowed: true }
  const perms = getPerms(req)
  const has =
    perms.includes('sales.create') ||
    perms.includes('cashclosure.create') ||
    perms.includes('cashclosure.create_day') ||
    perms.includes('cashclosure.create_own')
  return has ? { allowed: true } : { allowed: false, status: 403, message: 'No tiene permiso para apertura de caja' }
}

/** Quién puede cerrar un turno OPEN: admin, quien abrió, o supervisor de caja (create / create_day). */
function checkCanCloseThisSession (req, session) {
  const user = req.user
  if (!user?.sub) return { allowed: false, status: 401, message: 'No autenticado' }
  if (isAdminUser(user)) return { allowed: true }
  const perms = getPerms(req)
  if (perms.includes('cashclosure.create') || perms.includes('cashclosure.create_day')) {
    return { allowed: true }
  }
  if (String(session.opened_by_id) === String(user.sub)) {
    return { allowed: true }
  }
  return {
    allowed: false,
    status: 403,
    message: 'Solo quien abrió el turno o un supervisor de caja puede cerrarlo.'
  }
}

/**
 * Resuelve la caja a usar: 1) la indicada explícitamente, 2) la asignada al
 * usuario (si está activa), 3) la default.
 */
async function resolveRegister (client, explicitId, userId, branchId) {
  if (explicitId) {
    return client.cashRegister.findFirst({ where: { id: String(explicitId), active: true, branch_id: branchId } })
  }
  if (userId) {
    // Antes de caer en "mi caja asignada" o la de la sucursal, buscar dónde
    // el usuario tiene trabajo real pendiente (turno abierto, o cerrado sin
    // arqueo todavía) — así una caja ad hoc (no asignada, no default) se
    // sigue encontrando después de cerrar el turno, en vez de perderse.
    const ownWork = await client.cashRegisterSession.findFirst({
      where: {
        opened_by_id: String(userId),
        cashRegister: { branch_id: branchId, active: true },
        OR: [{ status: 'OPEN' }, { status: 'CLOSED', cash_closure_id: null }],
      },
      orderBy: [{ opened_at: 'desc' }],
      select: {
        cashRegister: { select: { id: true, name: true, code: true, is_default: true, active: true, branch_id: true } },
      },
    })
    if (ownWork?.cashRegister) return ownWork.cashRegister

    const user = await client.user.findUnique({
      where: { id: String(userId) },
      select: { cashRegister: { select: { id: true, name: true, code: true, is_default: true, active: true, branch_id: true } } }
    })
    if (user?.cashRegister?.active && user.cashRegister.branch_id === branchId) return user.cashRegister
  }
  return client.cashRegister.findFirst({ where: { is_default: true, active: true, branch_id: branchId } })
}

const sessionInclude = {
  openedBy: { select: { id: true, name: true, email: true } },
  closedBy: { select: { id: true, name: true, email: true } },
  cashRegister: { select: { id: true, name: true, code: true, is_default: true } },
  cashClosure: { select: { id: true, closure_number: true, status: true } }
}

/** Gestionar cajas (crear/editar): admin o settings.manage. */
function checkCanManageRegisters (req) {
  const user = req.user
  if (!user) return { allowed: false, status: 401, message: 'No autenticado' }
  if (isAdminUser(user)) return { allowed: true }
  const perms = getPerms(req)
  return perms.includes('settings.manage')
    ? { allowed: true }
    : { allowed: false, status: 403, message: 'No tiene permiso para gestionar cajas' }
}

/**
 * GET /api/cash-sessions/registers
 * Query: include_inactive=1 (solo gestores) para el panel de administración.
 */
exports.listRegisters = async (req, res, next) => {
  try {
    const perm = checkCanReadCashSession(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }
    const wantsAll = String(req.query.include_inactive || '') === '1'
    const includeInactive = wantsAll && checkCanManageRegisters(req).allowed
    const { branchWhere } = require('../middlewares/tenant')
    const rows = await prisma.cashRegister.findMany({
      where: { ...(includeInactive ? {} : { active: true }), ...branchWhere(req) },
      orderBy: [{ is_default: 'desc' }, { name: 'asc' }],
      include: {
        branch: { select: { id: true, name: true, code: true } },
        assigned_users: { select: { id: true, name: true } },
        sessions: {
          where: { status: 'OPEN' },
          take: 1,
          select: {
            id: true,
            opened_at: true,
            opening_float: true,
            opened_by_id: true,
            openedBy: { select: { id: true, name: true } },
          },
        },
      }
    })
    res.json(rows.map(({ sessions, ...r }) => ({
      ...r,
      has_open_session: sessions.length > 0,
      open_session: sessions[0]
        ? {
            id: sessions[0].id,
            opened_at: sessions[0].opened_at,
            opening_float: sessions[0].opening_float,
            opened_by_id: sessions[0].opened_by_id,
            opened_by_name: sessions[0].openedBy?.name ?? null,
          }
        : null,
    })))
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/cash-sessions/registers
 * Body: { name, code? } — code se genera del nombre si no viene.
 */
exports.createRegister = async (req, res, next) => {
  try {
    const perm = checkCanManageRegisters(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    const name = String(req.body.name || '').trim().slice(0, 120)
    if (!name) return res.status(400).json({ message: 'El nombre es requerido' })

    let code = String(req.body.code || '').trim().slice(0, 40)
    if (!code) {
      code = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'CAJA'
    }

    const { requireBranch } = require('../middlewares/tenant')
    const branchId = requireBranch(req)
    const existing = await prisma.cashRegister.findFirst({ where: { code, branch_id: branchId } })
    if (existing) {
      return res.status(409).json({ message: `Ya existe una caja con el código "${code}" en la sucursal` })
    }

    const created = await prisma.cashRegister.create({
      data: { name, code, is_default: false, active: true, branch_id: branchId }
    })
    res.status(201).json(created)
  } catch (e) {
    next(e)
  }
}

/**
 * PUT /api/cash-sessions/registers/:id/users
 * Body: { user_ids: string[] } — deja asignados a esta caja exactamente esos
 * usuarios (quita a los que ya no estén en la lista).
 */
exports.setRegisterUsers = async (req, res, next) => {
  try {
    const perm = checkCanManageRegisters(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    const { id } = req.params
    const register = await prisma.cashRegister.findFirst({ where: { id, branch: { company_id: req.companyId } } })
    if (!register) return res.status(404).json({ message: 'Caja no encontrada' })
    if (!register.active) {
      return res.status(400).json({ message: 'No se pueden asignar usuarios a una caja inactiva' })
    }

    const rawIds = Array.isArray(req.body.user_ids) ? req.body.user_ids : null
    if (!rawIds) return res.status(400).json({ message: 'user_ids debe ser un arreglo' })
    const userIds = [...new Set(rawIds.map(String))]

    if (userIds.length > 0) {
      const found = await prisma.user.count({
        where: { id: { in: userIds }, user_branches: { some: { branch_id: register.branch_id } } },
      })
      if (found !== userIds.length) {
        return res.status(400).json({ message: 'Uno o más usuarios no existen o no pertenecen a la sucursal' })
      }
    }

    await prisma.$transaction([
      // Quitar la caja a quienes la tenían y ya no están en la lista
      prisma.user.updateMany({
        where: {
          cash_register_id: id,
          ...(userIds.length > 0 ? { id: { notIn: userIds } } : {})
        },
        data: { cash_register_id: null }
      }),
      ...(userIds.length > 0
        ? [prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { cash_register_id: id }
          })]
        : [])
    ])

    const assigned = await prisma.user.findMany({
      where: { cash_register_id: id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    })
    res.json({ ...register, assigned_users: assigned })
  } catch (e) {
    next(e)
  }
}

/**
 * PATCH /api/cash-sessions/registers/:id
 * Body: { name?, active?, is_default? } — is_default:true desmarca las demás.
 */
exports.updateRegister = async (req, res, next) => {
  try {
    const perm = checkCanManageRegisters(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    const { id } = req.params
    const register = await prisma.cashRegister.findFirst({ where: { id, branch: { company_id: req.companyId } } })
    if (!register) return res.status(404).json({ message: 'Caja no encontrada' })

    const data = {}
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 120)
      if (!name) return res.status(400).json({ message: 'El nombre no puede estar vacío' })
      data.name = name
    }
    if (req.body.active !== undefined) {
      const active = Boolean(req.body.active)
      if (!active) {
        if (register.is_default) {
          return res.status(400).json({ message: 'No se puede desactivar la caja predeterminada. Marque otra como predeterminada primero.' })
        }
        const openSession = await prisma.cashRegisterSession.findFirst({
          where: { cash_register_id: id, status: 'OPEN' }
        })
        if (openSession) {
          return res.status(409).json({ message: 'La caja tiene un turno abierto. Ciérrelo antes de desactivarla.' })
        }
      }
      data.active = active
    }

    const wantsDefault = req.body.is_default === true && !register.is_default
    const updated = await prisma.$transaction(async (tx) => {
      if (wantsDefault) {
        if (data.active === false) throw Object.assign(new Error('BAD_DEFAULT'), { status: 400 })
        if (!register.active && data.active !== true) {
          throw Object.assign(new Error('BAD_DEFAULT'), { status: 400 })
        }
        // La caja predeterminada es por sucursal, no global.
        await tx.cashRegister.updateMany({
          where: { is_default: true, branch_id: register.branch_id },
          data: { is_default: false },
        })
        data.is_default = true
      }
      return tx.cashRegister.update({ where: { id }, data })
    })
    res.json(updated)
  } catch (e) {
    if (e.message === 'BAD_DEFAULT') {
      return res.status(400).json({ message: 'La caja predeterminada debe estar activa' })
    }
    next(e)
  }
}

/**
 * GET /api/cash-sessions/current
 * Query: cash_register_id (opcional; si no, usa la caja marcada is_default)
 */
exports.getCurrent = async (req, res, next) => {
  try {
    const perm = checkCanReadCashSession(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    const registerId = req.query.cash_register_id || req.query.cashRegisterId || null
    const register = await resolveRegister(prisma, registerId, req.user?.sub, require('../middlewares/tenant').requireBranch(req))

    if (!register) {
      return res.status(503).json({ message: 'No hay caja configurada. Ejecute migraciones y seed.' })
    }

    const session = await prisma.cashRegisterSession.findFirst({
      where: { cash_register_id: register.id, status: 'OPEN' },
      include: sessionInclude
    })

    const uid = req.user?.sub
    let closable_session = null
    if (uid) {
      closable_session = await prisma.cashRegisterSession.findFirst({
        where: {
          cash_register_id: register.id,
          opened_by_id: String(uid),
          status: 'CLOSED',
          cash_closure_id: null
        },
        orderBy: [{ closed_at: 'desc' }, { opened_at: 'desc' }],
        include: sessionInclude
      })
    }

    res.json({ register, session, closable_session })
  } catch (e) {
    next(e)
  }
}

/**
 * POST /api/cash-sessions/open
 * Body: { opening_float, notes?, cash_register_id? }
 */
exports.openSession = async (req, res, next) => {
  try {
    const perm = checkCanMutateCashSession(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    const uid = req.user?.sub
    if (!uid) return res.status(401).json({ message: 'Usuario no autenticado' })

    const opening = number(req.body.opening_float)
    if (!Number.isFinite(opening) || opening < 0) {
      return res.status(400).json({ message: 'opening_float debe ser un número >= 0' })
    }

    let notes = req.body.notes != null ? String(req.body.notes).trim() : ''
    if (notes.length > 2000) notes = notes.slice(0, 2000)
    notes = notes || null

    const bodyRegisterId = req.body.cash_register_id || req.body.cashRegisterId || null

    const created = await prisma.$transaction(async (tx) => {
      const register = await resolveRegister(tx, bodyRegisterId, uid, require('../middlewares/tenant').requireBranch(req))
      if (!register) {
        throw new Error('NO_REGISTER')
      }

      const existing = await tx.cashRegisterSession.findFirst({
        where: { cash_register_id: register.id, status: 'OPEN' }
      })
      if (existing) {
        throw new Error('ALREADY_OPEN')
      }

      return tx.cashRegisterSession.create({
        data: {
          cash_register_id: register.id,
          opened_by_id: uid,
          opening_float: opening,
          notes,
          status: 'OPEN'
        },
        include: sessionInclude
      })
    })

    res.status(201).json(created)
  } catch (e) {
    if (e.message === 'ALREADY_OPEN') {
      return res.status(409).json({
        message:
          'Ya hay una sesión abierta en esta caja. Ciérrela desde Nueva venta (fin de turno), guarde un cierre de caja vinculado, o contacte a un supervisor.'
      })
    }
    if (e.message === 'NO_REGISTER') {
      return res.status(503).json({ message: 'No hay caja configurada' })
    }
    next(e)
  }
}

/**
 * POST /api/cash-sessions/close
 * Cierra el turno OPEN sin cierre contable (no sustituye «Cierre de caja» con arqueo).
 * Body: { notes?, cash_register_id? }
 */
exports.closeSession = async (req, res, next) => {
  try {
    const perm = checkCanMutateCashSession(req)
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    const uid = req.user?.sub
    if (!uid) return res.status(401).json({ message: 'Usuario no autenticado' })

    let extraNotes = req.body.notes != null ? String(req.body.notes).trim() : ''
    if (extraNotes.length > 2000) extraNotes = extraNotes.slice(0, 2000)
    const bodyRegisterId = req.body.cash_register_id || req.body.cashRegisterId || null

    const closed = await prisma.$transaction(async (tx) => {
      const register = await resolveRegister(tx, bodyRegisterId, uid, require('../middlewares/tenant').requireBranch(req))
      if (!register) {
        throw new Error('NO_REGISTER')
      }

      const session = await tx.cashRegisterSession.findFirst({
        where: { cash_register_id: register.id, status: 'OPEN' },
        include: sessionInclude
      })
      if (!session) {
        throw new Error('NO_OPEN_SESSION')
      }

      const closePerm = checkCanCloseThisSession(req, session)
      if (!closePerm.allowed) {
        const err = new Error('FORBIDDEN_CLOSE')
        err.status = closePerm.status || 403
        err.clientMessage = closePerm.message
        throw err
      }

      let mergedNotes = session.notes != null ? String(session.notes) : ''
      const stamp = `[Fin turno POS ${new Date().toISOString()}]`
      if (extraNotes) {
        mergedNotes = mergedNotes ? `${mergedNotes}\n${stamp} ${extraNotes}` : `${stamp} ${extraNotes}`
      } else {
        mergedNotes = mergedNotes ? `${mergedNotes}\n${stamp}` : stamp
      }
      if (mergedNotes.length > 4000) mergedNotes = mergedNotes.slice(0, 4000)

      const now = new Date()
      const upd = await tx.cashRegisterSession.updateMany({
        where: { id: session.id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          closed_at: now,
          closed_by_id: uid,
          notes: mergedNotes || null
        }
      })
      if (upd.count !== 1) {
        throw new Error('SESSION_RACE')
      }

      return tx.cashRegisterSession.findUnique({
        where: { id: session.id },
        include: sessionInclude
      })
    })

    res.json(closed)
  } catch (e) {
    if (e.message === 'NO_OPEN_SESSION') {
      return res.status(409).json({ message: 'No hay un turno abierto en esta caja.' })
    }
    if (e.message === 'NO_REGISTER') {
      return res.status(503).json({ message: 'No hay caja configurada' })
    }
    if (e.message === 'FORBIDDEN_CLOSE') {
      return res.status(e.status || 403).json({ message: e.clientMessage || 'No autorizado' })
    }
    if (e.message === 'SESSION_RACE') {
      return res.status(409).json({ message: 'El turno ya fue cerrado. Actualice la página.' })
    }
    next(e)
  }
}
