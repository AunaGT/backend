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
const IncomingMerchandise = require('./controller')

const router = Router()

/**
 * GET /api/incoming-merchandise
 * List all incoming merchandise records with pagination
 */
router.get('/', Auth, hasPermission('merchandise.view'), IncomingMerchandise.list)

/**
 * GET /api/incoming-merchandise/report/pdf
 * (Antes de /:id para no capturar "report" como id)
 */
router.get('/report/pdf', Auth, hasPermission('merchandise.reports'), IncomingMerchandise.generateReport)

/**
 * PATCH /api/incoming-merchandise/:id/payment
 * Actualizar datos de pago del registro
 */
// Solo el permiso dedicado autoriza tocar pagos: ver detalles NO implica poder abonar.
const paymentEditors = hasPermission('merchandise.mark_paid')

router.patch('/:id/payment', Auth, paymentEditors, IncomingMerchandise.updatePayment)

/**
 * POST /api/incoming-merchandise/:id/payments
 * Registrar abono parcial
 */
router.post('/:id/payments', Auth, paymentEditors, IncomingMerchandise.addPaymentEntry)

/**
 * DELETE /api/incoming-merchandise/:id/payments/:entryId
 * Eliminar un abono
 */
router.delete(
  '/:id/payments/:entryId',
  Auth,
  paymentEditors,
  IncomingMerchandise.deletePaymentEntry
)

/**
 * GET /api/incoming-merchandise/:id
 * Get a single incoming merchandise record by ID
 */
router.get('/:id', Auth, hasPermission('merchandise.details'), IncomingMerchandise.getById)

module.exports = router
