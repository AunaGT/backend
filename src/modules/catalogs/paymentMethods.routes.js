/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const ctrl = require('./paymentMethods.controller')
const router = Router()

router.get('/', ctrl.list)

router.post('/', Auth, hasPermission('catalogs.manage'), ctrl.create)
router.put('/:id', Auth, hasPermission('catalogs.manage'), ctrl.update)
router.delete('/:id', Auth, hasPermission('catalogs.manage'), ctrl.remove)

module.exports = router
