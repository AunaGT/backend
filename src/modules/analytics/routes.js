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
const ctrl = require('./controller')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const router = Router()

router.use(Auth, hasPermission('analytics.view'))

/**
 * @openapi
 * tags:
 *   - name: Analytics
 *     description: Endpoints de análisis y reportes
 */

/**
 * @openapi
 * /analytics/summary:
 *   get:
 *     tags: [Analytics]
 *     summary: Resumen anual de ventas y rendimiento
 *     parameters:
 *       - in: query
 *         name: year
 *         schema: { type: integer, example: 2025 }
 *         description: Año del que se quiere obtener la información (desde la primera venta completada)
 *     responses:
 *       200:
 *         description: Resumen preparado para el tablero analítico
 */
router.get('/first-sale-year', ctrl.firstSaleYear)
router.get('/summary', ctrl.summary)

module.exports = router
