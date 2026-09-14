/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const Orders = require('./controller')

const router = Router()

router.get('/', Auth, hasPermission('orders.view'), Orders.list)
router.post('/', Auth, hasPermission('orders.create'), Orders.create)
router.get('/:id', Auth, hasPermission('orders.view'), Orders.getById)
router.put('/:id', Auth, hasPermission('orders.create'), Orders.update)
router.put('/:id/branch', Auth, hasPermission('orders.create'), Orders.changeBranch)
router.post('/:id/confirm', Auth, hasPermission('orders.manage'), Orders.confirm)
router.post('/:id/cancel', Auth, hasPermission('orders.manage'), Orders.cancel)
router.post('/:id/convert-to-sale', Auth, hasPermission('orders.manage', 'sales.create'), Orders.convertToSale)

module.exports = router
