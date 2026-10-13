/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const Orders = require('./controller')
const { requireModule } = require('../platform/middleware')

const router = Router()

router.get('/', Auth, hasPermission('orders.view'), Orders.list)
router.post('/', Auth, hasPermission('orders.create'), Orders.create)
router.get('/:id/share-link', Auth, hasPermission('orders.view'), Orders.getShareLink)
router.get('/:id', Auth, hasPermission('orders.view'), Orders.getById)
router.put('/:id', Auth, hasPermission('orders.create'), Orders.update)
router.patch('/:id/admin-details', Auth, hasPermission('orders.manage'), Orders.updateAdminDetails)
router.put('/:id/branch', Auth, hasPermission('orders.create'), Orders.changeBranch)
router.post('/:id/confirm', Auth, hasPermission('orders.manage'), Orders.confirm)
router.post('/:id/cancel', Auth, hasPermission('orders.manage'), Orders.cancel)
router.post('/:id/convert-to-sale', Auth, requireModule('sales'), hasPermission('orders.manage', 'sales.create'), Orders.convertToSale)
router.post('/:id/deliveries', Auth, hasPermission('orders.manage'), Orders.deliver)
router.post('/:id/deliveries/:deliveryId/reverse', Auth, hasPermission('orders.manage'), Orders.reverseDelivery)
router.post('/:id/invoices', Auth, requireModule('sales'), hasPermission('orders.manage'), hasPermission('sales.create'), Orders.invoice)

module.exports = router
