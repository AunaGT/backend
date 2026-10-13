/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const {
  calculateTheoretical,
  create,
  list,
  getById,
  validate,
  getLastClosureDate,
  validateStocks,
  updateStatus
} = require('./controller')

const router = Router()

// Cualquier permiso de crear cierre permite calcular y crear (el controlador valida día vs propio)
const canCreateAny = hasPermission('cashclosure.create', 'cashclosure.create_day', 'cashclosure.create_own')

// Validar stocks antes de permitir cierre
router.get('/validate-stocks', Auth, validateStocks)

// Calcular cierre teórico (Auth + al menos un permiso de crear; el controller valida tipo)
router.get('/calculate-theoretical', Auth, canCreateAny, calculateTheoretical)

// Obtener fecha del último cierre (cualquiera con acceso a cierres)
router.get('/last-closure-date', Auth, hasPermission('cashclosure.view', 'cashclosure.create', 'cashclosure.create_day', 'cashclosure.create_own'), getLastClosureDate)

// CRUD
router.get('/', Auth, hasPermission('cashclosure.view'), list)
router.get('/:id', Auth, hasPermission('cashclosure.view'), getById)
router.post('/', Auth, canCreateAny, create)

// Validar cierre (firma supervisor)
router.patch('/:id/validate', Auth, hasPermission('cashclosure.validate'), validate)

// Actualizar estado del cierre (Aprobar/Rechazar)
router.patch('/:id/status', Auth, hasPermission('cashclosure.approve', 'cashclosure.validate'), updateStatus)

module.exports = router
