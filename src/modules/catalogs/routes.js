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
const Catalogs = require('./controller')
const { Auth } = require('../../middlewares/autenticacion')
const router = Router()

/**
 * @openapi
 * tags:
 *   - name: Catalogs
 *     description: Catálogos para selects
 * /catalogs:
 *   get:
 *     tags: [Catalogs]
 *     summary: Obtener catálogos
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/', Auth, Catalogs.all)

/**
 * @openapi
 * /catalogs/statuses:
 *   get:
 *     tags: [Catalogs]
 *     summary: Obtener lista de estados (statuses)
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/statuses', Auth, Catalogs.statuses)

// Mount product categories management
router.use('/product-categories', require('./productCategories.routes'))
// Mount payment terms
router.use('/payment-terms', require('./paymentTerms.routes'))

router.use('/payment-methods', require('./paymentMethods.routes'))

module.exports = router
