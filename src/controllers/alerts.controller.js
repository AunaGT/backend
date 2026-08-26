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
const { syncLotExpiryAlerts } = require('../services/lots')

exports.list = async (req, res, next) => {
  try {
    const { DateTime } = require('luxon')
    await syncLotExpiryAlerts(prisma) // advisory, autothrottled; no hay cron en serverless
    // By default only show unresolved alerts (resolved = 0), unless ?all=true
    const showAll = req.query.all === 'true'

    const { branchWhere } = require('../middlewares/tenant')
    const alerts = await prisma.alert.findMany({
      where: { ...(showAll ? {} : { resolved: 0 }), ...branchWhere(req) },
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
      let friendlyTimestamp = ''
      if (a.timestamp) {
        // Convert from UTC to Guatemala time (CST, UTC-6)
        const gtTime = DateTime.fromJSDate(a.timestamp, { zone: 'utc' })
          .setZone('America/Guatemala')
          .setLocale('es')
        friendlyTimestamp = gtTime.toFormat("dd LLL yyyy HH:mm")
      }
      return {
        ...a,
        timestamp: friendlyTimestamp,
      }
    })
    res.json(adapted)
  } catch (e) { next(e) }
}

exports.create = async (req, res, next) => {
  try {
    const { requireBranch } = require('../middlewares/tenant')
    const { type_id, priority_id, title, product_id } = req.body || {}
    if (!type_id || !priority_id || !title || !product_id) {
      return res.status(400).json({ message: 'type_id, priority_id, title y product_id son requeridos' })
    }
    // Una alerta creada a mano nace Activa; status_id no es algo que quien
    // reporta el problema deba conocer o elegir.
    let status_id = req.body?.status_id
    if (!status_id) {
      const statusActiva = await prisma.status.findFirst({ where: { name: 'Activa' } })
      status_id = statusActiva?.id
    }
    const created = await prisma.alert.create({
      data: { ...req.body, status_id, resolved: 0, branch_id: requireBranch(req) },
      include: {
        type: true,
        priority: true,
        product: { include: { category: true } },
        status: true,
        assignedTo: true
      }
    })
    res.status(201).json(created)
  } catch (e) { next(e) }
}

/** Catálogos para el formulario de "Nueva Alerta". */
exports.types = async (req, res, next) => {
  try {
    res.json(await prisma.alertType.findMany({ orderBy: { name: 'asc' } }))
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
    const { requireCompany } = require('../middlewares/tenant')
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
