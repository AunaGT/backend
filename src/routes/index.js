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

// Basic ping
router.get('/', (req, res) => {
  res.json({ ok: true, message: 'API up' })
})

// Empresa + sucursal del request (req.companyId / req.branchId) para todas las rutas
router.use(resolveTenant)

// Empresas y sucursales
router.use('/companies', require('./companies.routes'))
router.use('/branches', require('./branches.routes'))
// Traslados de mercancía entre sucursales
router.use('/transfers', require('./transfers.routes'))
// Almacenes y ubicaciones dentro de la sucursal
router.use('/warehouses', require('./warehouses.routes'))
// Movimientos internos, ajustes y kardex por ubicación
router.use('/stock', require('./stock.routes'))

// Mount products routes
router.use('/products', require('./products.routes'))
// Mount suppliers routes
router.use('/suppliers', require('./suppliers.routes'))
// Mount catalogs routes
router.use('/catalogs', require('./catalogs.routes'))
// Mount sales and alerts
router.use('/sales', require('./sales.routes'))
router.use('/alerts', require('./alerts.routes'))
// Dashboard stats
router.use('/dashboard', require('./dashboard.routes'))
// Auth (users, login, etc.)
router.use('/auth', require('./usuarios.routes'))
// Users / auth routes
router.use('/auth', require('./usuarios.routes'))
// Analytics
router.use('/analytics', require('./analytics.routes'))
// Reports (PDF)
router.use('/reports', require('./reports.routes'))
// Returns (product returns/refunds)
router.use('/returns', require('./returns.routes'))
// Cash register sessions (apertura de caja)
router.use('/cash-sessions', require('./cashSessions.routes'))
// Cash closures (cierre de caja)
router.use('/cash-closures', require('./cashClosures.routes'))
// System settings (configuración)
router.use('/settings', require('./settings.routes'))
// Promotions (discount codes)
router.use('/promotions', require('./promotions.routes'))
// Incoming Merchandise (registro de mercancía)
router.use('/incoming-merchandise', require('./incomingMerchandise.routes'))
// Inventariado (conteo físico)
router.use('/inventory-counts', require('./inventoryCounts.routes'))
// Cotizaciones comerciales
router.use('/quotes', require('./quotes.routes'))
// Pedidos comerciales
router.use('/orders', require('./orders.routes'))
// Cotiz/pedidos: vencimientos y reportes operativos
router.use('/commercial-documents', require('./commercialDocuments.routes'))
// Contabilidad (partida doble)
router.use('/accounting', require('./accounting.routes'))
// RRHH (empleados, asistencia, anticipos)
router.use('/hr', require('./hr.routes'))


module.exports = router
