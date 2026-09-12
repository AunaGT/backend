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
const { resolveTenant } = require('../middlewares/tenant')
const { requireAnyModule, requireModule } = require('../modules/platform')
const promotionsModule = require('../modules/promotions/manifest')
const inventoryModule = require('../modules/inventory/manifest')
const salesModule = require('../modules/sales/manifest')

// Basic ping
router.get('/', (req, res) => {
  res.json({ ok: true, message: 'API up' })
})

// Empresa + sucursal del request (req.companyId / req.branchId) para todas las rutas
router.use(resolveTenant)

// Empresas y sucursales
router.use('/companies', require('./companies.routes'))
router.use('/branches', requireModule('branches'), require('./branches.routes'))
// Contratación/activación de módulos. Siempre queda disponible para poder
// recuperar una configuración que haya deshabilitado otro módulo.
router.use('/modules', require('../modules/platform/routes'))
// Traslados de mercancía entre sucursales
router.use('/transfers', requireModule('transfers'), require('./transfers.routes'))
for (const inventoryRoute of inventoryModule.routes) {
  router.use(
    inventoryRoute.routePrefix,
    requireModule(inventoryModule.code),
    inventoryRoute.loadRouter()
  )
}
// Mount suppliers routes
router.use('/suppliers', requireModule('contacts'), require('./suppliers.routes'))
// Mount catalogs routes
router.use('/catalogs', requireModule('catalogs'), require('./catalogs.routes'))
for (const salesRoute of salesModule.routes) {
  router.use(
    salesRoute.routePrefix,
    requireModule(salesModule.code),
    salesRoute.loadRouter()
  )
}
// Mount alerts
router.use('/alerts', requireModule('alerts'), require('./alerts.routes'))
// Dashboard stats
router.use('/dashboard', requireModule('dashboard'), require('./dashboard.routes'))
// Auth (users, login, etc.)
router.use('/auth', require('./usuarios.routes'))
// Analytics
router.use('/analytics', requireModule('analytics'), require('./analytics.routes'))
// Reports (PDF)
router.use('/reports', requireModule('reports'), require('./reports.routes'))
// Returns (product returns/refunds)
router.use('/returns', requireModule('returns'), require('./returns.routes'))
// Cash closures (cierre de caja)
router.use('/cash-closures', requireModule('cash-closure'), require('./cashClosures.routes'))
// System settings (configuración)
router.use('/settings', require('./settings.routes'))
// Promotions (discount codes)
router.use(promotionsModule.routePrefix, requireModule(promotionsModule.code), promotionsModule.loadRouter())
// Incoming Merchandise (registro de mercancía)
router.use('/incoming-merchandise', requireModule('merchandise'), require('./incomingMerchandise.routes'))
// Inventariado (conteo físico)
router.use('/inventory-counts', requireModule('inventory-count'), require('./inventoryCounts.routes'))
// Cotizaciones comerciales
router.use('/quotes', requireModule('quotes'), require('./quotes.routes'))
// Pedidos comerciales
router.use('/orders', requireModule('orders'), require('./orders.routes'))
// Cotiz/pedidos: vencimientos y reportes operativos
router.use('/commercial-documents', requireAnyModule('quotes', 'orders'), require('./commercialDocuments.routes'))
// Contabilidad (partida doble)
router.use('/accounting', requireModule('accounting'), require('./accounting.routes'))
// RRHH (empleados, asistencia, anticipos)
router.use('/hr', requireModule('hr'), require('./hr.routes'))
// Nómina (planillas y recibos)
router.use('/payroll', requireModule('payroll'), require('./payroll.routes'))
// Cartera (cuentas por cobrar de clientes)
router.use('/receivables', requireModule('receivables'), require('./receivables.routes'))


module.exports = router
