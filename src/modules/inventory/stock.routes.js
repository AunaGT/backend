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
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const StockMoves = require('./stock.controller')

const canView = hasPermission('stock_moves.view', 'stock_moves.create', 'products.view')

router.get('/moves', Auth, canView, StockMoves.list)
router.get('/by-location', Auth, canView, StockMoves.stockByLocation)
router.get('/replenishment', Auth, canView, StockMoves.replenishment)
router.put('/by-location/min', Auth, hasPermission('stock_moves.create'), StockMoves.setLocationMin)
router.post('/moves', Auth, hasPermission('stock_moves.create'), StockMoves.createMove)
// Crear o destruir existencias sin documento tiene su propio permiso.
router.post('/adjustments', Auth, hasPermission('stock_moves.adjust'), StockMoves.createAdjustment)

module.exports = router
