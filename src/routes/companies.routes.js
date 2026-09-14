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
const Companies = require('../controllers/companies.controller')

router.get('/', Auth, Companies.list)
router.post('/', Auth, hasPermission('companies.manage'), Companies.create)
router.put('/:id', Auth, hasPermission('companies.manage'), Companies.update)
router.put('/:id/users', Auth, hasPermission('companies.manage'), Companies.assignUsers)
router.post('/:id/users/:userId', Auth, hasPermission('companies.manage'), Companies.addUser)
router.patch('/:id/users/:userId/experience-profile', Auth, hasPermission('users.edit'), Companies.updateUserExperienceProfile)
router.delete('/:id/users/:userId', Auth, hasPermission('companies.manage'), Companies.removeUser)

module.exports = router
