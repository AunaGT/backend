/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 */

const { Router } = require('express')
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const InventoryCounts = require('./controller')

const router = Router()

router.get(
  '/',
  Auth,
  hasPermission('inventory_count.view', 'reports.view'),
  InventoryCounts.list
)
router.post('/', Auth, hasPermission('inventory_count.create'), InventoryCounts.create)
router.get(
  '/:id',
  Auth,
  hasPermission('inventory_count.view', 'reports.view'),
  InventoryCounts.getById
)
router.get(
  '/:id/lines',
  Auth,
  hasPermission('inventory_count.view', 'inventory_count.count'),
  InventoryCounts.listLines
)
router.post('/:id/start', Auth, hasPermission('inventory_count.create'), InventoryCounts.start)
router.patch(
  '/:id/lines/:lineId',
  Auth,
  hasPermission('inventory_count.count'),
  InventoryCounts.updateLine
)
router.post(
  '/:id/submit',
  Auth,
  hasPermission('inventory_count.submit'),
  InventoryCounts.submit
)
router.post(
  '/:id/approve',
  Auth,
  hasPermission('inventory_count.approve'),
  InventoryCounts.approve
)
router.post('/:id/cancel', Auth, hasPermission('inventory_count.cancel'), InventoryCounts.cancel)

module.exports = router
