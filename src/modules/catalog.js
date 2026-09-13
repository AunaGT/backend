const manifests = [
  require('./dashboard/manifest'),
  require('./inventory/manifest'),
  require('./catalogs/manifest'),
  require('./contacts/manifest'),
  require('./branches/manifest'),
  require('./users/manifest'),
  require('./config/manifest'),
  require('./sales/manifest'),
  require('./quotes/manifest'),
  require('./orders/manifest'),
  require('./inventory-count/manifest'),
  require('./returns/manifest'),
  require('./cash-closure/manifest'),
  require('./receivables/manifest'),
  require('./merchandise/manifest'),
  require('./analytics/manifest'),
  require('./accounting/manifest'),
  require('./reports/manifest'),
  require('./alerts/manifest'),
  require('./promotions/manifest'),
  require('./transfers/manifest'),
  require('./hr/manifest'),
  require('./payroll/manifest'),
]

const MODULE_MANIFESTS = Object.freeze([...manifests])
const MODULE_MANIFEST_BY_CODE = new Map(MODULE_MANIFESTS.map((manifest) => [manifest.code, manifest]))

function getManifestRoutes(manifest) {
  if (Array.isArray(manifest.routes)) return manifest.routes
  return [{ routePrefix: manifest.routePrefix, loadRouter: manifest.loadRouter }]
}

module.exports = {
  MODULE_MANIFESTS,
  MODULE_MANIFEST_BY_CODE,
  getManifestRoutes,
}
