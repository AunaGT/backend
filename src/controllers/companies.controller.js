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
const { seedCompanySettings } = require('../services/companySettings')
const { seedChartOfAccounts } = require('../services/accounting/seedChartOfAccounts')
const { invalidateSystemConfigCache } = require('../utils/getTimezone')
const { seedCompanyModules } = require('../modules/platform/service')

const COMPANY_SELECT = {
  id: true, name: true, code: true, tax_id: true, address: true,
  phone: true, logo_url: true, active: true, is_default: true,
}

// GET /api/companies — empresas a las que pertenece el usuario
exports.list = async (req, res, next) => {
  try {
    const rows = await prisma.userCompany.findMany({
      where: { user_id: req.user.sub, company: { active: true } },
      select: { experience_profile: true, company: { select: COMPANY_SELECT } },
      orderBy: { company: { name: 'asc' } },
    })
    res.json(rows.map((r) => ({ ...r.company, experience_profile: r.experience_profile ?? null })))
  } catch (e) { next(e) }
}

// POST /api/companies — crea empresa + su sucursal principal y agrega al creador
exports.create = async (req, res, next) => {
  try {
    const { name, code, tax_id, address, phone, logo_url, branch_name, branch_code } = req.body || {}
    if (!name || !code) {
      return res.status(400).json({ message: 'name y code son obligatorios' })
    }
    const result = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { name, code: String(code).toUpperCase(), tax_id, address, phone, logo_url },
        select: COMPANY_SELECT,
      })
      const branch = await tx.branch.create({
        data: {
          company_id: company.id,
          name: branch_name || 'Principal',
          code: String(branch_code || 'PRIN').toUpperCase(),
          is_default: true,
        },
        select: { id: true, name: true, code: true },
      })
      await tx.userCompany.create({ data: { user_id: req.user.sub, company_id: company.id } })
      await tx.userBranch.create({ data: { user_id: req.user.sub, branch_id: branch.id } })
      // Nace configurada: moneda, zona horaria, denominaciones y sus datos fiscales
      await seedCompanySettings(tx, company.id, company)
      // Nace con catálogo de cuentas y mapeo por defecto: sin esto no puede contabilizar nada
      await seedChartOfAccounts(tx, company.id)
      // Compatibilidad inicial: las empresas nuevas reciben el catálogo modular
      // completo. Luego un administrador comercial puede suspender módulos.
      await seedCompanyModules(tx, company.id)
      return { ...company, branches: [branch] }
    })
    res.status(201).json(result)
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe una empresa con ese código' })
    }
    next(e)
  }
}

// PUT /api/companies/:id
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params
    const member = await prisma.userCompany.findUnique({
      where: { user_id_company_id: { user_id: req.user.sub, company_id: id } },
    })
    if (!member) return res.status(403).json({ message: 'Sin acceso a esa empresa' })

    const { name, tax_id, address, phone, logo_url, active } = req.body || {}
    const data = {}
    if (name !== undefined) data.name = name
    if (tax_id !== undefined) data.tax_id = tax_id
    if (address !== undefined) data.address = address
    if (phone !== undefined) data.phone = phone
    if (logo_url !== undefined) data.logo_url = logo_url
    if (active !== undefined) data.active = Boolean(active)

    const company = await prisma.company.update({ where: { id }, data, select: COMPANY_SELECT })

    // Espejo a las claves que usan los PDFs y membretes (ver settings.update)
    const mirror = []
    if (name !== undefined) mirror.push(['company_name', String(name)])
    if (tax_id !== undefined) mirror.push(['company_nit', String(tax_id ?? '')])
    if (address !== undefined) mirror.push(['company_address', String(address ?? '')])
    if (logo_url !== undefined) mirror.push(['company_logo_url', String(logo_url ?? '')])
    for (const [key, value] of mirror) {
      await prisma.systemSetting.upsert({
        where: { company_id_key: { company_id: id, key } },
        update: { value, type: 'string' },
        create: { company_id: id, key, value, type: 'string' },
      })
    }
    if (mirror.length > 0) invalidateSystemConfigCache(id)

    res.json(company)
  } catch (e) { next(e) }
}

/** El que administra debe pertenecer a la empresa que toca. */
async function assertMember(req, companyId) {
  const member = await prisma.userCompany.findUnique({
    where: { user_id_company_id: { user_id: req.user.sub, company_id: companyId } },
  })
  if (!member) {
    const err = new Error('Sin acceso a esa empresa')
    err.status = 403
    throw err
  }
}

// POST /api/companies/:id/users/:userId — da acceso a la empresa (sin sucursales aún)
exports.addUser = async (req, res, next) => {
  try {
    const { id, userId } = req.params
    await assertMember(req, id)
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' })

    await prisma.userCompany.upsert({
      where: { user_id_company_id: { user_id: userId, company_id: id } },
      update: {},
      create: { user_id: userId, company_id: id },
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

// PATCH /api/companies/:id/users/:userId/experience-profile
// Solo cambia cuánto detalle ve inicialmente. Nunca concede permisos.
exports.updateUserExperienceProfile = async (req, res, next) => {
  try {
    const { id, userId } = req.params
    await assertMember(req, id)
    const value = req.body?.experience_profile
    const profile = value == null || value === '' ? null : String(value).toUpperCase()
    if (profile !== null && !['CASHIER', 'MANAGER', 'OWNER', 'ADVANCED'].includes(profile)) {
      return res.status(400).json({ message: 'Perfil de experiencia no válido' })
    }

    const membership = await prisma.userCompany.findUnique({
      where: { user_id_company_id: { user_id: userId, company_id: id } },
      select: { user_id: true },
    })
    if (!membership) return res.status(404).json({ message: 'El usuario no pertenece a esta empresa' })

    const updated = await prisma.userCompany.update({
      where: { user_id_company_id: { user_id: userId, company_id: id } },
      data: { experience_profile: profile },
      select: { experience_profile: true },
    })
    res.json({ experience_profile: updated.experience_profile })
  } catch (e) { next(e) }
}

// DELETE /api/companies/:id/users/:userId — quita el acceso y sus sucursales ahí
exports.removeUser = async (req, res, next) => {
  try {
    const { id, userId } = req.params
    await assertMember(req, id)
    if (userId === req.user.sub) {
      return res.status(400).json({ message: 'No puedes quitarte a ti mismo de la empresa' })
    }

    await prisma.$transaction(async (tx) => {
      await tx.userBranch.deleteMany({
        where: { user_id: userId, branch: { company_id: id } },
      })
      await tx.userCompany.deleteMany({ where: { user_id: userId, company_id: id } })
      // Si su sucursal por defecto era de esta empresa, deja de serlo
      const remaining = await tx.userBranch.findFirst({
        where: { user_id: userId },
        select: { branch_id: true },
      })
      await tx.user.update({
        where: { id: userId },
        data: { default_branch_id: remaining?.branch_id ?? null },
      })
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

// PUT /api/companies/:id/users — reemplaza los usuarios de la empresa
exports.assignUsers = async (req, res, next) => {
  try {
    const { id } = req.params
    const { user_ids } = req.body || {}
    if (!Array.isArray(user_ids)) {
      return res.status(400).json({ message: 'user_ids debe ser un arreglo' })
    }
    if (!user_ids.includes(req.user.sub)) {
      return res.status(400).json({ message: 'No puedes quitarte a ti mismo de la empresa' })
    }
    const member = await prisma.userCompany.findUnique({
      where: { user_id_company_id: { user_id: req.user.sub, company_id: id } },
    })
    if (!member) return res.status(403).json({ message: 'Sin acceso a esa empresa' })

    await prisma.$transaction(async (tx) => {
      await tx.userCompany.deleteMany({ where: { company_id: id, user_id: { notIn: user_ids } } })
      for (const uid of user_ids) {
        await tx.userCompany.upsert({
          where: { user_id_company_id: { user_id: uid, company_id: id } },
          update: {},
          create: { user_id: uid, company_id: id },
        })
      }
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
}
