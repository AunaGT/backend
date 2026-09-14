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
const { Auth, hasPermission } = require('../../middlewares/autenticacion')
const {
  salesReport,
  inventoryReport,
  suppliersReport,
  financialReport,
  alertsReport,
  productsReport,
  merchandiseReport,
  inventoryCountSessionReport,
  inventoryCountsHistoryReport,
} = require('./controller')
const {
  stockByLocationReport,
  kardexReport,
  internalMovesReport,
  replenishmentReport,
  occupancyReport,
} = require('./stock.controller')

const router = Router()

const canViewReports = hasPermission('reports.view')

router.get('/sales', Auth, canViewReports, salesReport)
router.get('/inventory', Auth, canViewReports, inventoryReport)
router.get('/suppliers', Auth, canViewReports, suppliersReport)
router.get('/financial', Auth, canViewReports, financialReport)
router.get('/alerts', Auth, canViewReports, alertsReport)
router.get('/products', Auth, canViewReports, productsReport)
// Almacenes y ubicaciones: se ven con permiso de reportes o de movimientos.
const canViewStock = hasPermission('reports.view', 'stock_moves.view')
router.get('/stock-by-location', Auth, canViewStock, stockByLocationReport)
router.get('/kardex', Auth, canViewStock, kardexReport)
router.get('/internal-moves', Auth, canViewStock, internalMovesReport)
router.get('/replenishment', Auth, canViewStock, replenishmentReport)
router.get('/occupancy', Auth, canViewStock, occupancyReport)

router.get(
  '/merchandise',
  Auth,
  hasPermission('merchandise.reports', 'reports.view'),
  merchandiseReport
)
router.get(
  '/inventory-count-session/:id',
  Auth,
  hasPermission('inventory_count.export', 'reports.view', 'inventory_count.view'),
  inventoryCountSessionReport
)
router.get(
  '/inventory-counts',
  Auth,
  hasPermission('inventory_count.export', 'reports.view', 'inventory_count.view'),
  inventoryCountsHistoryReport
)

module.exports = router
