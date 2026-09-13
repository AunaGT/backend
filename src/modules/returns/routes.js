/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const express = require('express')
const router = express.Router()
const controller = require('./controller')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')

// Proteger todas las rutas con JWT
router.use(Auth)

const canView = hasPermission('returns.view', 'returns.manage')
const canManage = hasPermission('returns.manage')

// GET /api/returns - Listar devoluciones
router.get('/', canView, controller.list)

// GET /api/returns/:id - Detalle de una devolución
router.get('/:id', canView, controller.getById)

// POST /api/returns - Crear nueva devolución
router.post('/', canManage, controller.create)

// PATCH /api/returns/:id/status - Actualizar estado de devolución
router.patch('/:id/status', canManage, controller.updateStatus)

module.exports = router
