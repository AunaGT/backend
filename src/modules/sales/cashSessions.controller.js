/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 *
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 *
 * For licensing inquiries: GitHub @dpatzan2
 */

const { prisma } = require('../../models/prisma')
const { lockScopedSession, lockScopedRegister } = require('../../services/cashSessionBoundary')

const number = (v) => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : 0
}

function isAdminUser (user) {
  return require('../users/roles/policy').isSystemAdmin(user?.role)
}

function getPerms (req) {
  return Array.isArray(req.user?.permissions) ? req.user.permissions.map(String) : []
}

function checkCanReadCashSession (req) {
  const user = req.user
  if (!user) return { allowed: false, status: 401, message: 'No autenticado' }
  if (isAdminUser(user)) return { allowed: true }
  const perms = getPerms(req)
  const has = require('../../services/cashSharedSessions').operationPermissions.filter(p => p !== 'returns.complete').some(p => perms.includes(p)) ||
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
    const current = await require('../../services/cashSharedSessions').currentRegister(client, String(userId), branchId)
    if (current) return current
    // Antes de caer en "mi caja asignada" o la de la sucursal, buscar dónde
    // el usuario tiene trabajo real pendiente (turno abierto, o cerrado sin
    // arqueo todavía) — así una caja ad hoc (no asignada, no default) se
    // sigue encontrando después de cerrar el turno, en vez de perderse.
    const ownWork = await client.cashRegisterSession.findFirst({
      where: {
        opened_by_id: String(userId),
        cashRegister: { branch_id: branchId, active: true },
        // 3C: un turno con arqueo en reconteo vuelve a ser trabajo pendiente de su cajero.
        OR: [{ status: 'OPEN' }, { status: 'CLOSED', cash_closure_id: null }, { status: 'CLOSED', cashClosure: { status: 'Reconteo' } }],
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
    const { hasPerm } = require('../../middlewares/tenant')
    const metadata = hasPerm(req.user, 'cash.registers.view') || hasPerm(req.user, 'cash.registers.manage') || hasPerm(req.user, 'settings.manage')
    if (metadata && (String(req.query.include_inactive || '') === '1' || !perm.allowed)) {
      const branchId = require('../../middlewares/tenant').requireBranch(req)
      const rows = await prisma.cashRegister.findMany({ where: { branch_id: branchId, branch: { company_id: req.companyId }, ...(String(req.query.include_inactive || '') === '1' ? {} : { active: true }) }, orderBy: [{ is_default: 'desc' }, { name: 'asc' }] })
      const available = await require('./cashRegisters.configuration').registerConfigurationAvailable(prisma)
      const details = available && rows.length ? await prisma.$queryRaw`SELECT r.id,r.access_control_version,(SELECT count(*)::int FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE' JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id WHERE a.register_id=r.id AND a.active) AS authorized_user_count FROM cash_registers r WHERE r.id=ANY(${rows.map(r => r.id)}::uuid[])` : []
      const hydrated = await require('../../services/cashMetadata').hydrateCashMetadata(prisma, rows, 'registers')
      res.set?.('Cache-Control', 'private, no-store')
      return res.json(hydrated.map(r => ({ ...r, ...details.find(d => d.id === r.id) })))
    }
    if (!perm.allowed) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }
    const wantsAll = String(req.query.include_inactive || '') === '1'
    const includeInactive = wantsAll && checkCanManageRegisters(req).allowed
    const { branchWhere } = require('../../middlewares/tenant')
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
    const hydrated = await require('../../services/cashMetadata').hydrateCashMetadata(prisma, rows, 'registers')
    const accessAvailable = await require('./cashRegisters.configuration').registerConfigurationAvailable(prisma)
    const access = accessAvailable && rows.length ? await prisma.$queryRaw`SELECT r.id,r.access_control_version,
      EXISTS(SELECT 1 FROM cash_register_access a JOIN user_companies uc ON uc.user_id=a.user_id AND uc.company_id=a.company_id AND uc.status='ACTIVE' JOIN user_branches ub ON ub.user_id=a.user_id AND ub.branch_id=a.branch_id WHERE a.register_id=r.id AND a.user_id=${req.user.sub}::uuid AND a.active) AS can_open
      FROM cash_registers r WHERE r.id=ANY(${rows.map(r => r.id)}::uuid[])` : []
    res.set?.('Cache-Control', 'private, no-store')
    const result = hydrated.map(({ sessions, ...r }) => ({
      ...r,
      ...access.find(a => a.id === r.id),
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
    }))
    for (const r of result) if (r.open_session && r.operation_mode === 'SHARED' && r.money_event_version === 1) {
      const effective = await require('../../services/cashSharedSessions').view(prisma,{companyId:req.companyId,branchId:require('../../middlewares/tenant').requireBranch(req),userId:req.user.sub},
        { id:r.open_session.id,cash_register_id:r.id,status:'OPEN',operation_mode:'SHARED',money_event_version:1 })
      r.open_session.can_operate = effective.can_operate === true
    }
    res.json(result)
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
    const scope = require('./cashRegisters.access').cashRegisterAccess(req, 'legacy-manage')
    const result = await prisma.$transaction(tx => require('./cashRegisters.configuration').legacyRegisterCommand(tx, scope, 'create', req.params?.id, req.body))
    res.set?.('Cache-Control', 'private, no-store')
    res.status(201).json(result)
  } catch (error) { next(error) }
}

/**
 * PUT /api/cash-sessions/registers/:id/users
 * Body: { user_ids: string[] } — deja asignados a esta caja exactamente esos
 * usuarios (quita a los que ya no estén en la lista).
 */
exports.setRegisterUsers = async (req, res, next) => {
  try {
    const scope = require('./cashRegisters.access').cashRegisterAccess(req, 'legacy-manage')
    const result = await prisma.$transaction(tx => require('./cashRegisters.configuration').legacyRegisterCommand(tx, scope, 'users', req.params?.id, req.body))
    res.set?.('Cache-Control', 'private, no-store')
    res.status(200).json(result)
  } catch (error) { next(error) }
}

/**
 * PATCH /api/cash-sessions/registers/:id
 * Body: { name?, active?, is_default? } — is_default:true desmarca las demás.
 */
exports.updateRegister = async (req, res, next) => {
  try {
    const scope = require('./cashRegisters.access').cashRegisterAccess(req, 'legacy-manage')
    const result = await prisma.$transaction(tx => require('./cashRegisters.configuration').legacyRegisterCommand(tx, scope, 'update', req.params?.id, req.body))
    res.set?.('Cache-Control', 'private, no-store')
    res.status(200).json(result)
  } catch (error) { next(error) }
}

/**
 * GET /api/cash-sessions/current
 * Query: cash_register_id (opcional; si no, usa la caja marcada is_default)
 */
// Solo un arqueo en reconteo deja un turno cerrado con arqueo como pendiente (ver la consulta de closable_session).
const closableView = session => session ? { ...session, recount: !!session.cash_closure_id } : null
exports.getCurrent = async (req, res, next) => {
  try {
    const perm = checkCanReadCashSession(req)
    const settlementOnly = !perm.allowed && require('../../middlewares/tenant').hasPerm(req.user, 'returns.complete')
    if (!perm.allowed && !settlementOnly) {
      return res.status(perm.status || 403).json({ message: perm.message || 'No autorizado' })
    }

    if (req.query.cash_register_session_id) {
      const branchId = require('../../middlewares/tenant').requireBranch(req)
      const row = await prisma.cashRegisterSession.findFirst({ where: { id: String(req.query.cash_register_session_id), cashRegister: { branch_id: branchId, branch: { company_id: req.companyId } } }, include: sessionInclude })
      if (!row) return res.status(404).json({ message: 'Turno no encontrado' })
      const [s] = await require('../../services/cashMetadata').hydrateCashMetadata(prisma, [row])
      const canDeclare = s.opened_by_id === req.user.sub || s.operation_mode === 'SHARED' && (isAdminUser(req.user) || getPerms(req).some(p => ['cashclosure.create','cashclosure.create_day'].includes(p)))
      if (!canDeclare || settlementOnly) return res.status(404).json({ message: 'Turno no encontrado' })
      res.set?.('Cache-Control', 'private, no-store')
      return res.json({ register: s.cashRegister, session: s.status === 'OPEN' ? s : null, closable_session: s.status === 'CLOSED' ? { ...s, recount: s.cashClosure?.status === 'Reconteo', can_declare: true } : null })
    }

    const registerId = req.query.cash_register_id || req.query.cashRegisterId || null
    const register = await resolveRegister(prisma, registerId, req.user?.sub, require('../../middlewares/tenant').requireBranch(req))

    if (!register) {
      return res.status(503).json({ message: 'No hay caja configurada. Ejecute migraciones y seed.' })
    }

    if (settlementOnly) {
      let session = await prisma.cashRegisterSession.findFirst({ where: { cash_register_id: register.id, opened_by_id: req.user.sub, status: 'OPEN' }, select: { id:true,status:true } })
      const shared = require('../../services/cashSharedSessions')
      if (!session && await shared.available(prisma)) {
        const [s] = await prisma.$queryRaw`SELECT id,cash_register_id,status,operation_mode,money_event_version FROM cash_register_sessions WHERE cash_register_id=${register.id}::uuid AND status='OPEN' AND operation_mode='SHARED' AND money_event_version=1`
        if (s && (await shared.view(prisma,{companyId:req.companyId,branchId:register.branch_id,userId:req.user.sub},s)).can_operate) session={id:s.id,status:s.status}
      }
      res.set?.('Cache-Control', 'private, no-store')
      return res.json({ register: { id: register.id, name: register.name, code: register.code }, session, closable_session: null })
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
          OR: [{ cash_closure_id: null }, { cashClosure: { status: 'Reconteo' } }]
        },
        orderBy: [{ closed_at: 'desc' }, { opened_at: 'desc' }],
        include: sessionInclude
      })
    }

    const hydratedSessions = await require('../../services/cashMetadata').hydrateCashMetadata(prisma, [session, closable_session].filter(Boolean))
    const hydratedRegisters = await require('../../services/cashMetadata').hydrateCashMetadata(prisma, [register], 'registers')
    const visibleSession = await require('../../services/cashSharedSessions').view(prisma, { companyId: req.companyId, branchId: register.branch_id, userId: uid }, hydratedSessions.find(s => s.id === session?.id) || null)
    res.set?.('Cache-Control', 'private, no-store')
    res.json({ register: hydratedRegisters[0], session: visibleSession, closable_session: closableView(hydratedSessions.find(s => s.id === closable_session?.id)) })
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

    const opening = Number(require('../receivables/paymentAttempts').exactMoney(req.body.opening_float ?? 0, { allowZero: true }))
    if (!Number.isFinite(opening) || opening < 0) {
      return res.status(400).json({ message: 'opening_float debe ser un número >= 0' })
    }

    let notes = req.body.notes != null ? String(req.body.notes).trim() : ''
    if (notes.length > 2000) notes = notes.slice(0, 2000)
    notes = notes || null

    const bodyRegisterId = req.body.cash_register_id || req.body.cashRegisterId || null

    const created = await prisma.$transaction(async (tx) => {
      const register = await resolveRegister(tx, bodyRegisterId, uid, require('../../middlewares/tenant').requireBranch(req))
      if (!register) {
        throw new Error('NO_REGISTER')
      }

      const lockedRegister = await lockScopedRegister(tx, { companyId: req.companyId, branchId: require('../../middlewares/tenant').requireBranch(req), userId: uid, isAdmin: isAdminUser(req.user) }, register.id)

      const existing = await tx.cashRegisterSession.findFirst({
        where: { cash_register_id: register.id, status: 'OPEN' }
      })
      if (existing) {
        const [meta] = await require('../../services/cashMetadata').hydrateCashMetadata(tx, [existing])
        if (require('../../services/cashSharedSessions').isShared(meta)) {
          const joined = await require('../../services/cashSharedSessions').join(tx, { companyId: req.companyId, branchId: register.branch_id, userId: uid }, existing.id)
          return { ...await tx.cashRegisterSession.findUnique({ where: { id: existing.id }, include: sessionInclude }), ...joined }
        }
        throw new Error('ALREADY_OPEN')
      }

      const eventSession = await require('../../services/cashEventAdoption').openEventSession(tx, { companyId: req.companyId, branchId: register.branch_id || require('../../middlewares/tenant').requireBranch(req), userId: uid }, lockedRegister, { openingFloat: req.body.opening_float ?? 0, notes })
      if (eventSession) return { ...await tx.cashRegisterSession.findUnique({ where: { id: eventSession.id }, include: sessionInclude }), ...eventSession }
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
      const register = await resolveRegister(tx, bodyRegisterId, uid, require('../../middlewares/tenant').requireBranch(req))
      if (!register) {
        throw new Error('NO_REGISTER')
      }

      const candidate = await tx.cashRegisterSession.findFirst({
        where: { cash_register_id: register.id, status: 'OPEN' },
        include: sessionInclude
      })
      if (!candidate) {
        throw new Error('NO_OPEN_SESSION')
      }
      if (req.body.cash_register_session_id !== undefined && req.body.cash_register_session_id !== candidate.id) throw new Error('SESSION_RACE')

      const session = await lockScopedSession(tx, { companyId: req.companyId, branchId: require('../../middlewares/tenant').requireBranch(req), userId: uid }, candidate.id)
      if (session.status !== 'OPEN') throw new Error('SESSION_RACE')

      const closePerm = checkCanCloseThisSession(req, session)
      if (!closePerm.allowed) {
        const err = new Error('FORBIDDEN_CLOSE')
        err.status = closePerm.status || 403
        err.clientMessage = closePerm.message
        throw err
      }
      if (session.operation_mode === 'SHARED' && session.opened_by_id !== uid && !extraNotes) throw Object.assign(new Error('Indica por qué terminas el turno de otra persona.'), { status: 400 })

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

exports.capabilities = async (req, res, next) => {
  try {
    const permission = checkCanReadCashSession(req)
    const { hasPerm } = require('../../middlewares/tenant')
    const canView = hasPerm(req.user, 'cash.registers.view') || hasPerm(req.user, 'cash.registers.manage'), canManage = hasPerm(req.user, 'cash.registers.manage')
    if (!permission.allowed && !canView && !hasPerm(req.user, 'settings.manage')) return res.status(permission.status).json({ message: permission.message })
    res.set?.('Cache-Control', 'private, no-store')
    res.json({ ...await require('../../services/cashEventAdoption').capabilities(prisma, { isAdmin: isAdminUser(req.user) }), shared_turns_available: await require('../../services/cashSharedSessions').available(prisma), register_configuration_available: await require('./cashRegisters.configuration').registerConfigurationAvailable(prisma), can_view_register_configuration: canView, can_manage_register_configuration: canManage })
  } catch (error) { next(error) }
}

exports.joinSession = async (req, res, next) => {
  try {
    if (req.integrationCredential || req.integration) throw Object.assign(new Error('Inicia sesión para unirte al turno'), { status: 401 })
    const perm = checkCanMutateCashSession(req)
    if (!perm.allowed && !require('../../services/cashSharedSessions').operationPermissions.some(p => getPerms(req).includes(p))) return res.status(perm.status).json({ message: perm.message })
    if (Object.keys(req.body || {}).length) throw Object.assign(new Error('Para unirte solo se necesita el turno; tu identidad viene de la sesión.'), { status: 400 })
    const scope = { companyId: req.companyId, branchId: require('../../middlewares/tenant').requireBranch(req), userId: req.user.sub }
    const result = await prisma.$transaction(tx => require('../../services/cashSharedSessions').join(tx, scope, req.params.id))
    res.set?.('Cache-Control', 'private, no-store')
    res.json(result)
  } catch (error) { next(error) }
}
exports.adoptRegister = async (req, res, next) => {
  try {
    if (!isAdminUser(req.user)) throw Object.assign(new Error('Solo el administrador del sistema puede habilitar el registro de movimientos.'), { status: 403 })
    const scope = { companyId: req.companyId, branchId: require('../../middlewares/tenant').requireBranch(req), userId: req.user.sub, isAdmin: true }
    res.json(await prisma.$transaction(tx => require('../../services/cashEventAdoption').adoptRegister(tx, scope, req.params.id, req.body)))
  } catch (error) { next(error) }
}
exports.paymentOptions = async (req, res, next) => {
  try {
    const scope = require('../merchandise/payables/access').payableScope(req)
    scope.branchId = require('../../middlewares/tenant').requireBranch(req)
    await require('../merchandise/payables/access').assertAccess(prisma, scope, { write: true })
    if (!await require('../cash-closure/eventStorage').ledgerAvailable(prisma)) return res.json({ available: false, sessions: [] })
    const sessions = await prisma.$queryRaw`SELECT s.id,s.cash_register_id,s.opened_by_id,s.status,s.operation_mode,s.money_event_version,r.id AS "cashRegisterId",r.name,r.code,s.currency_code AS "currencyCode",s.money_event_version AS "moneyEventVersion"
      FROM cash_register_sessions s JOIN cash_registers r ON r.id=s.cash_register_id JOIN branches b ON b.id=r.branch_id
      WHERE b.company_id=${scope.companyId}::uuid AND r.branch_id=${scope.branchId}::uuid AND r.active AND r.kind='PHYSICAL'
      AND s.status='OPEN' AND (s.opened_by_id=${scope.userId}::uuid OR s.operation_mode='SHARED') ORDER BY r.name,s.id`
    const visible = []
    for (const s of sessions) {
      if (s.operation_mode === 'SHARED' && !(await require('../../services/cashSharedSessions').view(prisma,scope,s)).can_operate) continue
      visible.push({ id:s.id,cashRegisterId:s.cashRegisterId,name:s.name,code:s.code,currencyCode:s.currencyCode,moneyEventVersion:s.moneyEventVersion })
    }
    res.json({ available: true, sessions: visible })
  } catch (error) { next(error) }
}

exports.getConfiguration = async (req, res, next) => {
  try {
    const scope = require('./cashRegisters.access').cashRegisterAccess(req, 'view')
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await prisma.$transaction(tx => require('./cashRegisters.configuration').loadRegisterConfiguration(tx, scope, req.params.id)))
  } catch (error) { next(error) }
}
exports.saveConfiguration = async (req, res, next) => {
  try {
    const scope = require('./cashRegisters.access').cashRegisterAccess(req, 'manage')
    if (Object.hasOwn(req.body, 'id')) throw Object.assign(new Error('La caja se identifica en la dirección, no en los datos enviados'), { status: 400 })
    const result = await prisma.$transaction(tx => require('./cashRegisters.configuration').saveRegisterConfiguration(tx, scope, { ...req.body, ...(req.params.id ? { id: req.params.id } : {}) }))
    res.set?.('Cache-Control', 'private, no-store')
    res.status(req.params.id || result.replayed ? 200 : 201).json(result)
  } catch (error) { next(error) }
}
exports.registerUsers = async (req, res, next) => {
  try {
    const scope = require('./cashRegisters.access').cashRegisterAccess(req, 'manage')
    res.set?.('Cache-Control', 'private, no-store')
    res.json(await require('./cashRegisters.configuration').listEligibleRegisterUsers(prisma, scope, req.query))
  } catch (error) { next(error) }
}
