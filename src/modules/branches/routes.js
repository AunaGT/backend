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
const Branches = require('./controller')

router.get('/', Auth, Branches.list)
router.post('/', Auth, hasPermission('branches.manage'), Branches.create)
router.put('/assign', Auth, hasPermission('branches.manage', 'users.edit'), Branches.assignUser)
router.get('/user/:userId', Auth, hasPermission('branches.manage', 'users.view'), Branches.listForUser)
router.put('/:id', Auth, hasPermission('branches.manage'), Branches.update)

module.exports = router
