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
const { requireModule } = require('../platform/middleware')
const { prisma } = require('../../models/prisma')
const { validateReportScope } = require('./reportFilters')
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
async function validateFilters(req, res, next) {
  try { req.reportLocations = await validateReportScope(prisma, req); next() } catch (error) { next(error) }
}

router.get('/sales', Auth, canViewReports, requireModule('sales'), validateFilters, salesReport)
router.get('/inventory', Auth, canViewReports, requireModule('inventory'), validateFilters, inventoryReport)
router.get('/suppliers', Auth, canViewReports, requireModule('contacts'), validateFilters, suppliersReport)
router.get('/financial', Auth, canViewReports, requireModule('sales'), requireModule('inventory'), validateFilters, financialReport)
router.get('/alerts', Auth, canViewReports, requireModule('alerts'), validateFilters, alertsReport)
router.get('/products', Auth, canViewReports, requireModule('inventory'), validateFilters, productsReport)
// Almacenes y ubicaciones: se ven con permiso de reportes o de movimientos.
const canViewStock = hasPermission('reports.view', 'stock_moves.view')
router.get('/stock-by-location', Auth, canViewStock, requireModule('inventory'), validateFilters, stockByLocationReport)
router.get('/kardex', Auth, canViewStock, requireModule('inventory'), validateFilters, kardexReport)
router.get('/internal-moves', Auth, canViewStock, requireModule('inventory'), validateFilters, internalMovesReport)
router.get('/replenishment', Auth, canViewStock, requireModule('inventory'), validateFilters, replenishmentReport)
router.get('/occupancy', Auth, canViewStock, requireModule('inventory'), validateFilters, occupancyReport)

router.get(
  '/merchandise',
  Auth,
  hasPermission('merchandise.reports', 'reports.view'),
  requireModule('merchandise'),
  validateFilters,
  merchandiseReport
)
router.get(
  '/inventory-count-session/:id',
  Auth,
  hasPermission('inventory_count.export', 'reports.view', 'inventory_count.view'),
  requireModule('inventory-count'),
  validateFilters,
  inventoryCountSessionReport
)
router.get(
  '/inventory-counts',
  Auth,
  hasPermission('inventory_count.export', 'reports.view', 'inventory_count.view'),
  requireModule('inventory-count'),
  validateFilters,
  inventoryCountsHistoryReport
)

module.exports = router
