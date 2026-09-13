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
const {
  MODULE_MANIFESTS,
  MODULE_MANIFEST_BY_CODE,
  getManifestRoutes,
} = require('../modules/catalog')

const quotesModule = MODULE_MANIFEST_BY_CODE.get('quotes')

function mountModule(appRouter, manifest) {
  for (const moduleRoute of getManifestRoutes(manifest)) {
    const handlers = manifest.guardAtMount === false
      ? [moduleRoute.loadRouter()]
      : [requireModule(manifest.code), moduleRoute.loadRouter()]
    appRouter.use(moduleRoute.routePrefix, ...handlers)
  }
}

// Basic ping
router.get('/', (req, res) => {
  res.json({ ok: true, message: 'API up' })
})

router.use(quotesModule.routePrefix, quotesModule.loadPublicRouter())

// Empresa + sucursal del request (req.companyId / req.branchId) para todas las rutas
router.use(resolveTenant)

// Empresa y contratación de módulos son capacidades de la plataforma.
router.use('/companies', require('./companies.routes'))
router.use('/modules', require('../modules/platform/routes'))

// Cada capacidad de negocio entra únicamente por su manifiesto. El router de
// usuarios es la excepción deliberada: login/refresh son públicos y sus rutas
// administrativas aplican requireModule dentro del propio router.
for (const manifest of MODULE_MANIFESTS) mountModule(router, manifest)

// Cotiz/pedidos: vencimientos y reportes operativos
router.use(
  '/commercial-documents',
  requireAnyModule(
    MODULE_MANIFEST_BY_CODE.get('quotes').code,
    MODULE_MANIFEST_BY_CODE.get('orders').code
  ),
  require('./commercialDocuments.routes')
)


module.exports = router
