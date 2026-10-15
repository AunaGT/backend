const bcrypt = require('bcryptjs')
const { prisma, prismaTransaction } = require('../../models/prisma')
const roleService = require('./roles/service')
const { requireCompany } = require('../../middlewares/tenant')
const { listQuery, assertGrant, permissions, fail, PASSWORD_CHANGE_REQUIRED } = require('../../services/userAccess')
const { isSystemAdmin } = require('./roles/policy')

const roleInclude = { permissions: { include: { permission: true } } }
const memberWhere = req => ({ user_companies: { some: { company_id: requireCompany(req) } } })
const handle = fn => async (req, res, next) => { try { await fn(req, res) } catch (e) { next(e) } }
const event = (tx, req, userId, action) => tx.userAccessEvent.create({ data: { company_id: requireCompany(req), user_id: userId, actor_id: req.user.sub, action } })
const includes = companyId => ({
  role: { include: roleInclude },
  user_companies: { where: { company_id: companyId }, include: { company: { select: { id: true, name: true, code: true } }, role: { include: roleInclude } } },
  user_branches: { where: { branch: { company_id: companyId } }, include: { branch: true } },
  cashRegister: { select: { id: true, name: true, code: true, active: true } },
  employee_record: { select: { id: true, code: true, first_name: true, last_name: true, status: true, phone: true, address: true, hire_date: true } },
  _count: { select: { user_companies: true } },
})
function serialize(user) {
  const member = user.user_companies[0], role = member?.role || user.role
  return {
    id: user.id, name: user.name, email: user.email, photo_url: user.photo_url,
    role_id: role.id, role: { id: role.id, name: role.name }, permissions: permissions(role),
    access_status: member?.status, last_login_at: user.last_login_at,
    companies: user.user_companies.map(m => ({ ...m.company, experience_profile: m.experience_profile })),
    branches: user.user_branches.map(m => m.branch), default_branch_id: user.default_branch_id,
    cash_register_id: user.cash_register_id, cash_register: user.cashRegister,
    employee: user.employee_record, is_employee: Boolean(user.employee_record),
    phone: user.employee_record?.phone, address: user.employee_record?.address, hire_date: user.employee_record?.hire_date,
    created_at: user.created_at, updated_at: user.updated_at, shared_account: user._count.user_companies > 1,
  }
}
async function target(tx, req) {
  const user = await tx.user.findFirst({ where: { id: req.params.id, ...memberWhere(req) }, include: includes(req.companyId) })
  if (!user) fail(404, 'Usuario no encontrado')
  return user
}
async function assignableRole(tx, req, id) {
  return roleService.resolveAssignableRole(tx, req, id)
}
function identity(body, creating = false) {
  const data = {}
  if (creating || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 150) fail(400, 'Nombre inválido')
    data.name = body.name.trim()
  }
  if (creating || body.email !== undefined) {
    if (typeof body.email !== 'string' || body.email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) fail(400, 'Correo inválido')
    data.email = body.email.trim().toLowerCase()
  }
  if (creating || body.password) {
    if (typeof body.password !== 'string' || body.password.length < 10 || Buffer.byteLength(body.password) > 72) fail(400, 'La contraseña debe tener al menos 10 caracteres y no superar 72 bytes')
  }
  return data
}

exports.list = handle(async (req, res) => {
  const companyId = requireCompany(req), { page, pageSize, orderBy } = listQuery(req.query)
  const where = { AND: [memberWhere(req)] }
  if (req.query.search) {
    const name = { contains: String(req.query.search), mode: 'insensitive' }
    where.AND.push({ OR: [
      { name }, { email: name },
      { user_companies: { some: { company_id: companyId, role: { name } } } },
      { role: { name }, user_companies: { some: { company_id: companyId, role_id: null } } },
    ] })
  }
  if (req.query.status) {
    if (!['ACTIVE', 'INACTIVE', 'BLOCKED'].includes(req.query.status)) fail(400, 'Estado inválido')
    where.AND.push({ user_companies: { some: { company_id: companyId, status: req.query.status } } })
  }
  if (req.query.role_id) {
    const roleId = Number(req.query.role_id)
    if (!Number.isSafeInteger(roleId)) fail(400, 'Rol inválido')
    where.AND.push({ OR: [
      { user_companies: { some: { company_id: companyId, role_id: roleId } } },
      { role_id: roleId, user_companies: { some: { company_id: companyId, role_id: null } } },
    ] })
  }
  if (req.query.branch_id) where.AND.push({ user_branches: { some: { branch_id: String(req.query.branch_id), branch: { company_id: companyId } } } })
  const totalItems = await prisma.user.count({ where }), totalPages = Math.max(1, Math.ceil(totalItems / pageSize)), safePage = Math.min(page, totalPages)
  let summary
  if (req.query.includeSummary === 'true') {
    const counts = await Promise.all(['ACTIVE', 'INACTIVE', 'BLOCKED'].map(status => prisma.user.count({ where: { AND: [where, { user_companies: { some: { company_id: companyId, status } } }] } })))
    summary = { total: totalItems, ACTIVE: counts[0], INACTIVE: counts[1], BLOCKED: counts[2] }
  }
  const items = await prisma.user.findMany({ where, orderBy, skip: (safePage - 1) * pageSize, take: pageSize, include: includes(companyId) })
  res.json({ items: items.map(serialize), page: safePage, pageSize, totalItems, totalPages, nextPage: safePage < totalPages ? safePage + 1 : null, prevPage: safePage > 1 ? safePage - 1 : null, ...(summary ? { summary } : {}) })
})
exports.getById = handle(async (req, res) => res.json(serialize(await target(prisma, req))))
exports.register = handle(async (req, res) => {
  const companyId = requireCompany(req), data = identity(req.body || {}, true)
  const status = req.body.access_status || 'ACTIVE'
  if (!['ACTIVE', 'INACTIVE'].includes(status)) fail(400, 'Estado inicial inválido')
  if (req.body.must_change_password !== undefined && typeof req.body.must_change_password !== 'boolean') fail(400, 'Cambio obligatorio inválido')
  const password = await bcrypt.hash(req.body.password, 10)
  const user = await (prismaTransaction || prisma).$transaction(async tx => {
    await roleService.lockRoleCompany(tx, companyId)
    const role = await assignableRole(tx, req, req.body.role_id)
    const created = await tx.user.create({ data: { ...data, password, role_id: role.id,
      user_companies: { create: { company_id: companyId, role_id: role.id, status } },
      ...(req.branchId ? { default_branch_id: req.branchId, user_branches: { create: { branch_id: req.branchId } } } : {}),
    } })
    await event(tx, req, created.id, 'Usuario creado')
    if (req.body.must_change_password) await event(tx, req, created.id, PASSWORD_CHANGE_REQUIRED)
    return tx.user.findUnique({ where: { id: created.id }, include: includes(companyId) })
  }, { timeout: 30000, maxWait: 5000 })
  // Crear una cuenta no autoriza iniciar una sesión como esa persona.
  res.status(201).json({ user: serialize(user) })
})
exports.update = handle(async (req, res) => {
  const body = req.body || {}, data = identity(body)
  const updated = await (prismaTransaction || prisma).$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM companies WHERE id = ${requireCompany(req)}::uuid FOR UPDATE`
    const user = await target(tx, req)
    if (user._count.user_companies > 1 && req.user.sub !== user.id && ((body.name !== undefined && body.name !== user.name) || (body.email !== undefined && body.email !== user.email) || body.password)) fail(403, 'La identidad de una cuenta compartida solo puede editarla su titular')
    if (body.password) { data.password = await bcrypt.hash(body.password, 10); data.auth_version = { increment: 1 }; data.password_changed_at = null }
    if (body.cash_register_id !== undefined) {
      if (body.cash_register_id && !await tx.cashRegister.findFirst({ where: { id: body.cash_register_id, active: true, branch: { company_id: req.companyId } } })) fail(400, 'Caja no disponible')
      data.cash_register_id = body.cash_register_id || null
    }
    if (body.role_id !== undefined) {
      const role = await assignableRole(tx, req, body.role_id)
      const oldRole = user.user_companies[0].role || user.role
      if (role.id !== oldRole.id && req.user.sub === user.id) fail(409, 'No puedes cambiar tu propio rol')
      if (isSystemAdmin(oldRole) && !isSystemAdmin(role)) {
        const others = await tx.userCompany.count({ where: { company_id: req.companyId, status: 'ACTIVE', user_id: { not: user.id }, OR: [{ role: { system_key: 'ADMIN' } }, { role_id: null, user: { role: { system_key: 'ADMIN' } } }] } })
        if (!others) fail(409, 'Debe permanecer un administrador activo')
      }
      await tx.userCompany.update({ where: { user_id_company_id: { user_id: user.id, company_id: req.companyId } }, data: { role_id: role.id } })
      if (role.id !== oldRole.id) await roleService.releaseRoleFallback(tx, user, req.companyId, oldRole, role)
    }
    await tx.user.update({ where: { id: user.id }, data })
    if (body.password) await tx.refreshToken.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } })
    await event(tx, req, user.id, 'Usuario actualizado')
    if (body.password) await event(tx, req, user.id, PASSWORD_CHANGE_REQUIRED)
    return target(tx, req)
  }, { timeout: 30000, maxWait: 5000 })
  res.json(serialize(updated))
})
exports.setAccess = handle(async (req, res) => {
  const status = req.body?.status
  if (!['ACTIVE', 'INACTIVE', 'BLOCKED'].includes(status)) fail(400, 'Estado inválido')
  if (req.params.id === req.user.sub && status !== 'ACTIVE') fail(409, 'No puedes suspender tu propio acceso')
  await prisma.$transaction(async tx => {
    // Serializa modificaciones de acceso dentro de la empresa.
    await tx.$queryRaw`SELECT id FROM companies WHERE id = ${requireCompany(req)}::uuid FOR UPDATE`
    const user = await target(tx, req)
    const currentRole = user.user_companies[0].role || user.role
    if (isSystemAdmin(currentRole) && status !== 'ACTIVE') {
      const others = await tx.userCompany.count({ where: { company_id: req.companyId, status: 'ACTIVE', user_id: { not: user.id }, OR: [{ role: { system_key: 'ADMIN' } }, { role_id: null, user: { role: { system_key: 'ADMIN' } } }] } })
      if (!others) fail(409, 'Debe permanecer un administrador activo')
    }
    await tx.userCompany.update({ where: { user_id_company_id: { user_id: user.id, company_id: req.companyId } }, data: { status } })
    if (status !== 'ACTIVE') {
      await tx.user.update({ where: { id: user.id }, data: { auth_version: { increment: 1 } } })
      await tx.refreshToken.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } })
    }
    await event(tx, req, user.id, `Acceso: ${status}`)
  })
  res.json({ ok: true })
})
exports.delete = handle(async () => fail(409, 'Desactiva el acceso de la empresa para conservar la cuenta y su historial'))
exports.activity = handle(async (req, res) => {
  await target(prisma, req)
  const { page, pageSize } = listQuery(req.query), where = { company_id: req.companyId, user_id: req.params.id }
  const totalItems = await prisma.userAccessEvent.count({ where })
  const items = await prisma.userAccessEvent.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize })
  const actorIds = [...new Set(items.map(item => item.actor_id).filter(Boolean))]
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : []
  const actorNames = new Map(actors.map(actor => [actor.id, actor.name]))
  res.json({ items: items.map(item => ({ ...item, actor_name: actorNames.get(item.actor_id) || null })), totalItems, page, pageSize, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)) })
})
exports.getRoles = handle(async (req, res) => res.json(await roleService.listRoles(prisma, req)))
exports.getRolesWithPermissions = handle(async (req, res) => res.json(await roleService.listRoles(prisma, req, { paged: true })))
exports.getRoleWithPermissions = handle(async (req, res) => res.json(await roleService.getRole(prisma, req, req.params.id)))
exports.createRole = handle(async (req, res) => res.status(201).json(await roleService.saveRole(prismaTransaction || prisma, req, null, req.body)))
exports.updateRole = handle(async (req, res) => res.json(await roleService.saveRole(prismaTransaction || prisma, req, req.params.id, req.body)))
exports.deleteRole = handle(async (req, res) => res.json(await roleService.deleteRole(prismaTransaction || prisma, req, req.params.id, req.body)))
