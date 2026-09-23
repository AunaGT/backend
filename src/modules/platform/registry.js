/**
 * Catálogo canónico de módulos del backend.
 *
 * `defaultEnabled` mantiene compatibilidad durante la migración: una empresa
 * sin fila explícita conserva el módulo. Una fila DISABLED/SUSPENDED sí lo
 * bloquea. Cuando todos los entornos estén migrados se puede cambiar la
 * política de altas sin tocar los routers.
 */
const MODULE_DEFINITIONS = Object.freeze([
  { code: 'inventory', name: 'Inventario', dependencies: [] },
  { code: 'catalogs', name: 'Datos maestros', dependencies: [] },
  { code: 'contacts', name: 'Contactos', dependencies: [] },
  { code: 'branches', name: 'Sucursales', dependencies: [] },
  { code: 'users', name: 'Usuarios', dependencies: [] },
  { code: 'config', name: 'Configuración', dependencies: [], protected: true },
  { code: 'sales', name: 'Ventas', dependencies: ['inventory'] },
  { code: 'quotes', name: 'Cotizaciones', dependencies: ['inventory', 'contacts'] },
  { code: 'orders', name: 'Pedidos', dependencies: ['inventory', 'contacts'] },
  { code: 'inventory-count', name: 'Inventariado', dependencies: ['inventory'] },
  { code: 'returns', name: 'Devoluciones', dependencies: ['sales', 'inventory'] },
  { code: 'cash-closure', name: 'Cierre de caja', dependencies: ['sales'] },
  { code: 'receivables', name: 'Cartera', dependencies: ['sales', 'contacts'] },
  { code: 'merchandise', name: 'Mercancía', dependencies: ['inventory', 'contacts'] },
  { code: 'analytics', name: 'Análisis', dependencies: ['sales'] },
  { code: 'accounting', name: 'Contabilidad', dependencies: [] },
  { code: 'reports', name: 'Reportes', dependencies: ['sales', 'inventory'] },
  { code: 'alerts', name: 'Alertas', dependencies: ['inventory'] },
  { code: 'promotions', name: 'Promociones', dependencies: ['sales', 'inventory'] },
  { code: 'transfers', name: 'Traslados', dependencies: ['inventory', 'branches'] },
  { code: 'hr', name: 'RRHH', dependencies: ['branches'] },
  { code: 'payroll', name: 'Nómina', dependencies: ['hr'] },
].map((definition) => Object.freeze({
  ...definition,
  dependencies: Object.freeze([...definition.dependencies]),
  defaultEnabled: true,
})))

const MODULE_BY_CODE = new Map(MODULE_DEFINITIONS.map((module) => [module.code, module]))
const ACTIVE_STATUSES = new Set(['ACTIVE', 'TRIAL'])

function getModuleDefinition(code) {
  return MODULE_BY_CODE.get(String(code)) || null
}

function assertRegistryValid() {
  for (const module of MODULE_DEFINITIONS) {
    for (const dependency of module.dependencies) {
      if (!MODULE_BY_CODE.has(dependency)) {
        throw new Error(`El módulo ${module.code} depende de ${dependency}, que no existe`)
      }
    }
  }

  const visiting = new Set()
  const visited = new Set()
  const visit = (code) => {
    if (visiting.has(code)) throw new Error(`Dependencia circular detectada en ${code}`)
    if (visited.has(code)) return
    visiting.add(code)
    for (const dependency of MODULE_BY_CODE.get(code).dependencies) visit(dependency)
    visiting.delete(code)
    visited.add(code)
  }
  for (const module of MODULE_DEFINITIONS) visit(module.code)
  return true
}

/** Resuelve activación propia + dependencias sin tocar la base de datos. */
function resolveEffectiveModules(rows = [], now = new Date()) {
  const rowByCode = new Map(rows.map((row) => [row.module_code, row]))
  const memo = new Map()

  const resolve = (definition) => {
    if (memo.has(definition.code)) return memo.get(definition.code)
    const row = rowByCode.get(definition.code)
    const persistedStatus = row?.status || (definition.defaultEnabled ? 'ACTIVE' : 'DISABLED')
    // Configuración es la vía de recuperación del sistema: ni una edición
    // manual incorrecta en DB debe dejarla inaccesible.
    const status = definition.protected ? 'ACTIVE' : persistedStatus
    const trialExpired = status === 'TRIAL' && row?.trial_ends_at
      ? new Date(row.trial_ends_at).getTime() <= now.getTime()
      : false
    const ownEnabled = ACTIVE_STATUSES.has(status) && !trialExpired
    const blockedBy = definition.dependencies.filter((dependencyCode) => {
      const dependency = resolve(MODULE_BY_CODE.get(dependencyCode))
      return !dependency.effectiveEnabled
    })
    const result = {
      code: definition.code,
      name: definition.name,
      dependencies: [...definition.dependencies],
      status,
      effectiveEnabled: ownEnabled && blockedBy.length === 0,
      blockedBy,
      trialEndsAt: row?.trial_ends_at || null,
      config: row?.config || {},
      persisted: Boolean(row),
      protected: Boolean(definition.protected),
    }
    memo.set(definition.code, result)
    return result
  }

  return MODULE_DEFINITIONS.map(resolve)
}

assertRegistryValid()

module.exports = {
  ACTIVE_STATUSES,
  MODULE_DEFINITIONS,
  assertRegistryValid,
  getModuleDefinition,
  resolveEffectiveModules,
}
