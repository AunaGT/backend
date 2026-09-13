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
const Transfers = require('./controller')

router.get('/', Auth, hasPermission('transfers.view'), Transfers.list)
router.get('/in-transit', Auth, hasPermission('transfers.view'), Transfers.inTransitReport)
router.post('/', Auth, hasPermission('transfers.create'), Transfers.create)
router.post('/:id/receive', Auth, hasPermission('transfers.receive'), Transfers.receive)
router.post('/:id/cancel', Auth, hasPermission('transfers.cancel'), Transfers.cancel)
router.get('/:id', Auth, hasPermission('transfers.view'), Transfers.getById)

module.exports = router
