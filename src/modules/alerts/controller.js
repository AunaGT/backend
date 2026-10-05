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
const { syncLotExpiryAlerts } = require('../../services/lots')
const { readCompanyModules } = require('../platform/service')
const { formatAlertTimestamp } = require('./presentation')
const { availableAlertTypes, withAlertModule } = require('./policy')

async function alertCatalogForCompany(companyId) {
  const [modules, types] = await Promise.all([
    readCompanyModules(companyId),
    prisma.alertType.findMany({ orderBy: { name: 'asc' } }),
  ])
  return { modules, types: availableAlertTypes(types, modules) }
}

exports.list = async (req, res, next) => {
  try {
    const catalog = await alertCatalogForCompany(req.companyId)
    if (catalog.modules.some((module) => module.code === 'inventory' && module.effectiveEnabled)) {
      await syncLotExpiryAlerts(prisma) // advisory, autothrottled; no hay cron en serverless
    }
    // By default only show unresolved alerts (resolved = 0), unless ?all=true
    const showAll = req.query.all === 'true'
    const availableTypeIds = catalog.types.map((type) => type.id)

    if (availableTypeIds.length === 0) return res.json([])

    const { branchWhere } = require('../../middlewares/tenant')
    const alerts = await prisma.alert.findMany({
      where: {
        ...(showAll ? {} : { resolved: 0 }),
        ...branchWhere(req),
        type_id: { in: availableTypeIds },
      },
      include: { 
        type: true, 
        priority: true, 
        product: { include: { category: true } }, 
        status: true, 
        assignedTo: true 
      },
      orderBy: { timestamp: 'desc' },
      take: 100,
    })
    
    // Format timestamps to friendly Guatemala local time
    const adapted = alerts.map(a => {
      const { timestamp, localDate, timestampIso } = formatAlertTimestamp(a.timestamp)
      return withAlertModule({
        ...a,
        timestamp,
        localDate,
        timestampIso,
      })
    })
    res.json(adapted)
  } catch (e) { next(e) }
}

exports.create = async (req, res, next) => {
  try {
    const { requireBranch } = require('../../middlewares/tenant')
    const { type_id, priority_id, title, product_id } = req.body || {}
    if (!type_id || !priority_id || !title || !product_id) {
      return res.status(400).json({ message: 'type_id, priority_id, title y product_id son requeridos' })
    }
    const catalog = await alertCatalogForCompany(req.companyId)
    const selectedType = catalog.types.find((type) => type.id === Number(type_id))
    if (!selectedType) {
      return res.status(409).json({
        code: 'ALERT_TYPE_MODULE_DISABLED',
        message: 'El tipo de alerta no está disponible para los módulos activos de esta empresa',
      })
    }
    const product = await prisma.product.findFirst({
      where: { id: String(product_id), company_id: req.companyId, deleted: false },
      select: { id: true },
    })
    if (!product) return res.status(404).json({ message: 'Producto no encontrado en esta empresa' })

    // Una alerta creada a mano nace Activa; status_id no es algo que quien
    // reporta el problema deba conocer o elegir.
    let status_id = req.body?.status_id
    if (!status_id) {
      const statusActiva = await prisma.status.findFirst({ where: { name: 'Activa' } })
      status_id = statusActiva?.id
    }
    const created = await prisma.alert.create({
      data: {
        type_id: Number(type_id),
        priority_id: Number(priority_id),
        title: String(title).trim(),
        message: req.body?.message ? String(req.body.message).trim() : null,
        product_id: String(product_id),
        current_stock: req.body?.current_stock ?? null,
        min_stock: req.body?.min_stock ?? null,
        status_id,
        resolved: 0,
        branch_id: requireBranch(req),
      },
      include: {
        type: true,
        priority: true,
        product: { include: { category: true } },
        status: true,
        assignedTo: true
      }
    })
    res.status(201).json(withAlertModule(created))
  } catch (e) { next(e) }
}

/** Catálogos para el formulario de "Nueva Alerta". */
exports.types = async (req, res, next) => {
  try {
    const { types } = await alertCatalogForCompany(req.companyId)
    res.json(types)
  } catch (e) { next(e) }
}

exports.priorities = async (req, res, next) => {
  try {
    res.json(await prisma.alertPriority.findMany({ orderBy: { id: 'asc' } }))
  } catch (e) { next(e) }
}

/**
 * Usuarios a quienes se les puede asignar una alerta. Pide alerts.manage, no
 * users.view — reasignar una alerta no debería exigir ver el padrón completo
 * de usuarios del sistema.
 */
exports.assignableUsers = async (req, res, next) => {
  try {
    const { requireCompany } = require('../../middlewares/tenant')
    const companyId = requireCompany(req)
    const users = await prisma.user.findMany({
      where: { user_companies: { some: { company_id: companyId } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    res.json(users)
  } catch (e) { next(e) }
}

// Reasignar alerta a otro usuario (admin)
exports.assign = async (req, res, next) => {
  try {
    const { id } = req.params
    const { user_id } = req.body || {}
    if (!user_id) return res.status(400).json({ message: 'user_id requerido' })
    const updated = await prisma.alert.update({
      where: { id },
      data: { assignedTo: { connect: { id: String(user_id) } } },
      include: { assignedTo: true }
    })
    res.json(updated)
  } catch (e) { next(e) }
}

// Marcar alerta como resuelta
exports.resolve = async (req, res, next) => {
  try {
    const { id } = req.params
    // `resolved` es lo que list() filtra; `status_id` es lo que la pantalla
    // muestra como insignia. syncLotExpiryAlerts ya actualiza los dos juntos
    // al autorresolver — acá solo faltaba el segundo, y la alerta quedaba
    // marcada resolved=1 pero con status "Activa" pegado.
    const statusResuelta = await prisma.status.findFirst({ where: { name: 'Resuelta' } })
    const updated = await prisma.alert.update({
      where: { id },
      data: { resolved: 1, ...(statusResuelta ? { status_id: statusResuelta.id } : {}) },
      include: {
        type: true,
        priority: true,
        product: { include: { category: true } },
        status: true,
        assignedTo: true
      }
    })
    res.json(updated)
  } catch (e) { next(e) }
}
