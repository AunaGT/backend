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
const { hasPerm } = require('../../middlewares/tenant')
const { uniqueCode } = require('../../utils/autoCode')

const BRANCH_SELECT = {
  id: true, company_id: true, name: true, code: true, address: true,
  phone: true, active: true, is_default: true,
}

// GET /api/branches — sucursales de la empresa actual.
// Por defecto solo las asignadas al usuario; ?all=1 (branches.manage) todas.
exports.list = async (req, res, next) => {
  try {
    const wantAll = req.query.all === '1' || req.query.all === 'true'
    if (wantAll) {
      if (!hasPerm(req.user, 'branches.manage') && !hasPerm(req.user, 'branches.view_all') && !hasPerm(req.user, 'users.view')) {
        return res.status(403).json({ message: 'No autorizado para listar todas las sucursales' })
      }
      const rows = await prisma.branch.findMany({
        where: { company_id: req.companyId },
        select: BRANCH_SELECT,
        orderBy: { name: 'asc' },
      })
      return res.json(rows)
    }
    const rows = await prisma.userBranch.findMany({
      where: { user_id: req.user.sub, branch: { company_id: req.companyId, active: true } },
      select: { branch: { select: BRANCH_SELECT } },
      orderBy: { branch: { name: 'asc' } },
    })
    res.json(rows.map((r) => r.branch))
  } catch (e) { next(e) }
}

// POST /api/branches — crea sucursal en la empresa actual
exports.create = async (req, res, next) => {
  try {
    const { name, code, address, phone } = req.body || {}
    if (!name) {
      return res.status(400).json({ message: 'name es obligatorio' })
    }
    // El código sale del nombre si no lo mandan: es una etiqueta interna, no
    // algo que el usuario deba inventar (y menos recordar cuáles ya usó).
    const branch = await prisma.$transaction(async (tx) => {
      const usados = code ? [] : (await tx.branch.findMany({
        where: { company_id: req.companyId }, select: { code: true },
      })).map((b) => b.code)
      const b = await tx.branch.create({
        data: {
          company_id: req.companyId,
          name,
          code: code ? String(code).toUpperCase() : uniqueCode(name, usados, 10),
          address,
          phone,
        },
        select: BRANCH_SELECT,
      })
      await tx.userBranch.create({ data: { user_id: req.user.sub, branch_id: b.id } })
      return b
    })
    res.status(201).json(branch)
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ message: 'Ya existe una sucursal con ese código en la empresa' })
    }
    next(e)
  }
}

// PUT /api/branches/:id
exports.update = async (req, res, next) => {
  try {
    const { id } = req.params
    const existing = await prisma.branch.findFirst({
      where: { id, company_id: req.companyId },
      select: { id: true },
    })
    if (!existing) return res.status(404).json({ message: 'Sucursal no encontrada' })

    const { name, address, phone, active, is_default } = req.body || {}
    const data = {}
    if (name !== undefined) data.name = name
    if (address !== undefined) data.address = address
    if (phone !== undefined) data.phone = phone
    if (active !== undefined) data.active = Boolean(active)
    if (is_default !== undefined) data.is_default = Boolean(is_default)

    const branch = await prisma.$transaction(async (tx) => {
      if (data.is_default === true) {
        await tx.branch.updateMany({
          where: { company_id: req.companyId, is_default: true },
          data: { is_default: false },
        })
      }
      return tx.branch.update({ where: { id }, data, select: BRANCH_SELECT })
    })
    res.json(branch)
  } catch (e) { next(e) }
}

// PUT /api/branches/assign — reemplaza las sucursales de un usuario DENTRO de
// la empresa actual (no toca sus asignaciones en otras empresas).
exports.assignUser = async (req, res, next) => {
  try {
    const { user_id, branch_ids, default_branch_id } = req.body || {}
    if (!user_id || !Array.isArray(branch_ids)) {
      return res.status(400).json({ message: 'user_id y branch_ids son obligatorios' })
    }
    // El usuario destino debe ser miembro de la empresa actual: la membresía a
    // la empresa se otorga aparte (companies.manage), aquí solo se reparten sucursales.
    const targetMembership = await prisma.userCompany.findUnique({
      where: { user_id_company_id: { user_id, company_id: req.companyId } },
    })
    if (!targetMembership) {
      return res.status(403).json({ message: 'El usuario no pertenece a la empresa actual' })
    }
    const companyBranches = await prisma.branch.findMany({
      where: { company_id: req.companyId },
      select: { id: true },
    })
    const companyBranchIds = companyBranches.map((b) => b.id)
    const invalid = branch_ids.filter((id) => !companyBranchIds.includes(id))
    if (invalid.length > 0) {
      return res.status(400).json({ message: 'Hay sucursales que no pertenecen a la empresa actual' })
    }
    if (default_branch_id && !branch_ids.includes(default_branch_id)) {
      return res.status(400).json({ message: 'La sucursal por defecto debe estar entre las asignadas' })
    }

    await prisma.$transaction(async (tx) => {
      await tx.userBranch.deleteMany({
        where: { user_id, branch_id: { in: companyBranchIds, notIn: branch_ids } },
      })
      for (const bid of branch_ids) {
        await tx.userBranch.upsert({
          where: { user_id_branch_id: { user_id, branch_id: bid } },
          update: {},
          create: { user_id, branch_id: bid },
        })
      }
      if (default_branch_id !== undefined) {
        await tx.user.update({ where: { id: user_id }, data: { default_branch_id } })
      }
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
}

// GET /api/branches/user/:userId — sucursales asignadas a un usuario en la empresa actual
exports.listForUser = async (req, res, next) => {
  try {
    const { userId } = req.params
    const rows = await prisma.userBranch.findMany({
      where: { user_id: userId, branch: { company_id: req.companyId } },
      select: { branch: { select: BRANCH_SELECT } },
    })
    const user = await prisma.user.findFirst({
      where: { id: userId, user_companies: { some: { company_id: req.companyId } } },
      select: { default_branch_id: true },
    })
    res.json({
      branches: rows.map((r) => r.branch),
      default_branch_id: user?.default_branch_id || null,
    })
  } catch (e) { next(e) }
}
