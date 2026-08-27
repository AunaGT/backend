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
router.delete('/payments/:id', Auth, hasPermission('receivables.manage'), Receivables.deletePayment)

module.exports = router
