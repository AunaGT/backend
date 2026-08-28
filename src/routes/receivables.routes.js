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
const router = Router()
const { Auth, hasPermission } = require('../middlewares/autenticacion')
const Receivables = require('../controllers/receivables.controller')

// Cartera
router.get('/', Auth, hasPermission('receivables.view'), Receivables.list)
// Antes de /customers/:id para que 'aging' no se lea como un id.
router.get('/aging', Auth, hasPermission('receivables.view'), Receivables.aging)
router.get('/overdue-count', Auth, hasPermission('receivables.view'), Receivables.overdueCount)
router.get('/customers/:id', Auth, hasPermission('receivables.view'), Receivables.statement)
// La consulta de crédito la usa el POS al vender, no la cartera.
router.get('/customers/:id/credit-check', Auth, hasPermission('sales.create'), Receivables.creditCheck)

// Cobros
router.post('/payments', Auth, hasPermission('receivables.manage'), Receivables.createPayment)
router.get('/payments/:id', Auth, hasPermission('receivables.view'), Receivables.receipt)
router.delete('/payments/:id', Auth, hasPermission('receivables.manage'), Receivables.deletePayment)
router.post(
  '/customers/:id/apply-credit',
  Auth,
  hasPermission('receivables.manage'),
  Receivables.applyCredit
)
router.patch(
  '/sales/:id/due-date',
  Auth,
  hasPermission('receivables.manage'),
  Receivables.updateDueDate
)

// Ajustes (nota de crédito, incobrable). Permiso aparte: borran deuda sin que
// entre dinero, así que no debería poder hacerlo cualquiera que cobre.
router.post('/adjustments', Auth, hasPermission('receivables.adjust'), Receivables.createAdjustment)

module.exports = router
