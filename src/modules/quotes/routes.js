/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const Quotes = require('./controller')
const { requireOrdersForConversion } = require('./access')

const router = Router()
router.use(require('../../middlewares/costVisibility').protectCostResponses)

router.get('/', Auth, hasPermission('quotes.view'), Quotes.list)
router.post('/', Auth, hasPermission('quotes.create'), Quotes.create)
router.get('/payment-terms-capability',Auth,hasPermission('quotes.create'),Quotes.paymentTermsCapability)
router.post('/service-conditions',Auth,hasPermission('quotes.create'),Quotes.previewServiceConditions)
router.post('/package-preview',Auth,hasPermission('quotes.create'),hasPermission('products.view'),Quotes.previewPackages)
router.get('/:id/share-link', Auth, hasPermission('quotes.view'), Quotes.getShareLink)
router.get('/:id', Auth, hasPermission('quotes.view'), Quotes.getById)
router.put('/:id', Auth, hasPermission('quotes.create'), Quotes.update)
router.patch('/:id/status', Auth, hasPermission('quotes.manage'), Quotes.updateStatus)
router.post('/:id/convert-to-sale',Auth,hasPermission('quotes.manage'),hasPermission('sales.create'),Quotes.convertToSale)
router.post(
  '/:id/convert-to-order',
  Auth,
  requireOrdersForConversion,
  hasPermission('quotes.manage'),
  hasPermission('orders.create'),
  Quotes.convertToOrder
)

module.exports = router
