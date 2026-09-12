/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../middlewares/autenticacion')
const Quotes = require('../controllers/quotes.controller')
const { requireOrdersForConversion } = require('../modules/quotes/access')

const router = Router()

router.get('/', Auth, hasPermission('quotes.view'), Quotes.list)
router.post('/', Auth, hasPermission('quotes.create'), Quotes.create)
router.get('/:id/share-link', Auth, hasPermission('quotes.view'), Quotes.getShareLink)
router.get('/:id', Auth, hasPermission('quotes.view'), Quotes.getById)
router.put('/:id', Auth, hasPermission('quotes.create'), Quotes.update)
router.patch('/:id/status', Auth, hasPermission('quotes.manage'), Quotes.updateStatus)
router.post(
  '/:id/convert-to-order',
  Auth,
  requireOrdersForConversion,
  hasPermission('quotes.manage'),
  Quotes.convertToOrder
)

module.exports = router
