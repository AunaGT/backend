const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

process.env.JWT_SECRET ||= 'auna-module-tests-only-not-for-production-2026'

const {
  MODULE_DEFINITIONS,
  assertRegistryValid,
  resolveEffectiveModules,
} = require('../src/modules/platform/registry')
const promotionsModule = require('../src/modules/promotions/manifest')
const inventoryModule = require('../src/modules/inventory/manifest')
const salesModule = require('../src/modules/sales/manifest')
const contactsModule = require('../src/modules/contacts/manifest')
const quotesModule = require('../src/modules/quotes/manifest')
const { MODULE_MANIFESTS, getManifestRoutes } = require('../src/modules/catalog')

test('el registro no contiene dependencias inexistentes ni circulares', () => {
  assert.equal(assertRegistryValid(), true)
  assert.equal(new Set(MODULE_DEFINITIONS.map((module) => module.code)).size, MODULE_DEFINITIONS.length)
})

test('cada definición tiene un único manifiesto HTTP sincronizado', () => {
  const manifestsByCode = new Map(MODULE_MANIFESTS.map((manifest) => [manifest.code, manifest]))

  assert.equal(MODULE_MANIFESTS.length, MODULE_DEFINITIONS.length)
  assert.equal(manifestsByCode.size, MODULE_MANIFESTS.length)

  for (const definition of MODULE_DEFINITIONS) {
    const manifest = manifestsByCode.get(definition.code)
    assert.ok(manifest, `Falta el manifiesto ${definition.code}`)
    assert.deepEqual([...manifest.dependencies], [...definition.dependencies])

    const routes = getManifestRoutes(manifest)
    assert.ok(routes.length > 0, `${definition.code} no declara rutas`)
    assert.equal(routes.every((route) => (
      typeof route.routePrefix === 'string' &&
      route.routePrefix.startsWith('/') &&
      typeof route.loadRouter === 'function'
    )), true)
  }
})

test('todos los manifiestos pueden cargar sus routers', () => {
  for (const manifest of MODULE_MANIFESTS) {
    for (const route of getManifestRoutes(manifest)) {
      const moduleRouter = route.loadRouter()
      assert.equal(typeof moduleRouter, 'function', `${manifest.code} no cargó un router Express`)
    }
    if (manifest.loadPublicRouter) {
      assert.equal(typeof manifest.loadPublicRouter(), 'function')
    }
  }
})

test('cada manifiesto carga routers físicos desde su propia carpeta', () => {
  for (const definition of MODULE_DEFINITIONS) {
    const manifestPath = path.join(__dirname, '..', 'src', 'modules', definition.code, 'manifest.js')
    const source = fs.readFileSync(manifestPath, 'utf8')
    const targets = [...source.matchAll(/load(?:Public)?Router:\s*\(\)\s*=>\s*require\(['"]([^'"]+)['"]\)/g)]
      .map((match) => match[1])

    assert.ok(targets.length > 0, `${definition.code} no publica un router`)
    assert.equal(
      targets.every((target) => target.startsWith('./')),
      true,
      `${definition.code} todavía carga un router fuera de su módulo`
    )
  }
})

test('la compatibilidad activa módulos cuando aún no existe una fila', () => {
  const modules = resolveEffectiveModules([])
  assert.equal(modules.length, MODULE_DEFINITIONS.length)
  assert.equal(modules.every((module) => module.effectiveEnabled), true)
  assert.equal(modules.every((module) => module.persisted === false), true)
})

test('desactivar inventario bloquea sus módulos dependientes', () => {
  const modules = resolveEffectiveModules([
    { module_code: 'inventory', status: 'DISABLED' },
  ])
  const byCode = new Map(modules.map((module) => [module.code, module]))
  assert.equal(byCode.get('inventory').effectiveEnabled, false)
  assert.equal(byCode.get('sales').effectiveEnabled, false)
  assert.deepEqual(byCode.get('sales').blockedBy, ['inventory'])
  assert.equal(byCode.get('promotions').effectiveEnabled, false)
})

test('inventario activo explícitamente queda disponible', () => {
  const inventory = resolveEffectiveModules([
    { module_code: 'inventory', status: 'ACTIVE' },
  ]).find((module) => module.code === 'inventory')

  assert.equal(inventory.status, 'ACTIVE')
  assert.equal(inventory.effectiveEnabled, true)
  assert.equal(inventory.persisted, true)
})

test('una prueba vencida de inventario queda desactivada efectivamente', () => {
  const inventory = resolveEffectiveModules([
    {
      module_code: 'inventory',
      status: 'TRIAL',
      trial_ends_at: new Date('2026-01-01T00:00:00.000Z'),
    },
  ], new Date('2026-01-02T00:00:00.000Z'))
    .find((module) => module.code === 'inventory')

  assert.equal(inventory.status, 'TRIAL')
  assert.equal(inventory.effectiveEnabled, false)
})

test('contactos activos explícitamente quedan disponibles', () => {
  const contacts = resolveEffectiveModules([
    { module_code: 'contacts', status: 'ACTIVE' },
  ]).find((module) => module.code === 'contacts')

  assert.equal(contacts.status, 'ACTIVE')
  assert.equal(contacts.effectiveEnabled, true)
  assert.equal(contacts.persisted, true)
})

test('contactos desactivados quedan bloqueados', () => {
  const contacts = resolveEffectiveModules([
    { module_code: 'contacts', status: 'DISABLED' },
  ]).find((module) => module.code === 'contacts')

  assert.equal(contacts.status, 'DISABLED')
  assert.equal(contacts.effectiveEnabled, false)
})

test('una prueba vencida de contactos queda desactivada efectivamente', () => {
  const contacts = resolveEffectiveModules([
    {
      module_code: 'contacts',
      status: 'TRIAL',
      trial_ends_at: new Date('2026-01-01T00:00:00.000Z'),
    },
  ], new Date('2026-01-02T00:00:00.000Z'))
    .find((module) => module.code === 'contacts')

  assert.equal(contacts.status, 'TRIAL')
  assert.equal(contacts.effectiveEnabled, false)
})

test('contactos no depende de inventario', () => {
  const contacts = resolveEffectiveModules([
    { module_code: 'inventory', status: 'DISABLED' },
    { module_code: 'contacts', status: 'ACTIVE' },
  ]).find((module) => module.code === 'contacts')

  assert.equal(contacts.effectiveEnabled, true)
  assert.deepEqual(contacts.blockedBy, [])
})

test('el manifiesto de contactos coincide con el registro y conserva el prefijo HTTP', () => {
  const definition = MODULE_DEFINITIONS.find((module) => module.code === contactsModule.code)
  assert.ok(definition)
  assert.deepEqual([...contactsModule.dependencies], [...definition.dependencies])
  assert.equal(contactsModule.routePrefix, '/suppliers')
  assert.equal(typeof contactsModule.loadRouter, 'function')
})

test('ventas activas explícitamente quedan disponibles', () => {
  const sales = resolveEffectiveModules([
    { module_code: 'sales', status: 'ACTIVE' },
  ]).find((module) => module.code === 'sales')

  assert.equal(sales.status, 'ACTIVE')
  assert.equal(sales.effectiveEnabled, true)
  assert.equal(sales.persisted, true)
})

test('ventas desactivadas quedan bloqueadas', () => {
  const sales = resolveEffectiveModules([
    { module_code: 'sales', status: 'DISABLED' },
  ]).find((module) => module.code === 'sales')

  assert.equal(sales.status, 'DISABLED')
  assert.equal(sales.effectiveEnabled, false)
})

test('una prueba vencida de ventas queda desactivada efectivamente', () => {
  const sales = resolveEffectiveModules([
    {
      module_code: 'sales',
      status: 'TRIAL',
      trial_ends_at: new Date('2026-01-01T00:00:00.000Z'),
    },
  ], new Date('2026-01-02T00:00:00.000Z'))
    .find((module) => module.code === 'sales')

  assert.equal(sales.status, 'TRIAL')
  assert.equal(sales.effectiveEnabled, false)
})

test('el manifiesto de ventas coincide con el registro y conserva prefijos HTTP', () => {
  const definition = MODULE_DEFINITIONS.find((module) => module.code === salesModule.code)
  assert.ok(definition)
  assert.deepEqual([...salesModule.dependencies], [...definition.dependencies])
  assert.deepEqual(
    salesModule.routes.map((route) => route.routePrefix),
    ['/sales', '/cash-sessions']
  )
  assert.equal(salesModule.routes.every((route) => typeof route.loadRouter === 'function'), true)
})

test('ventas rechaza códigos cuando promociones está desactivado', () => {
  const { requirePromotionsForSale } = require('../src/modules/sales/middleware')
  const modules = resolveEffectiveModules([
    { module_code: 'promotions', status: 'DISABLED' },
  ])
  const req = { body: { promotion_codes: ['PROMO10'] }, companyModules: modules }
  const response = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.payload = payload; return this },
  }
  let continued = false

  requirePromotionsForSale(req, response, () => { continued = true })

  assert.equal(continued, false)
  assert.equal(response.statusCode, 403)
  assert.equal(response.payload.code, 'MODULE_DISABLED')
  assert.equal(response.payload.module, 'promotions')
})

test('ventas sin códigos no exige promociones', () => {
  const { requirePromotionsForSale } = require('../src/modules/sales/middleware')
  const req = {
    body: { promotion_codes: [] },
    companyModules: resolveEffectiveModules([{ module_code: 'promotions', status: 'DISABLED' }]),
  }
  let continued = false

  requirePromotionsForSale(req, {}, () => { continued = true })

  assert.equal(continued, true)
})

test('ventas acepta códigos cuando promociones está activo', () => {
  const { requirePromotionsForSale } = require('../src/modules/sales/middleware')
  const req = {
    body: { promotion_codes: ['PROMO10'] },
    companyModules: resolveEffectiveModules([{ module_code: 'promotions', status: 'ACTIVE' }]),
  }
  let continued = false

  requirePromotionsForSale(req, {}, () => { continued = true })

  assert.equal(continued, true)
})

test('el manifiesto de inventario coincide con el registro y conserva prefijos HTTP', () => {
  const definition = MODULE_DEFINITIONS.find((module) => module.code === inventoryModule.code)
  assert.ok(definition)
  assert.deepEqual([...inventoryModule.dependencies], [...definition.dependencies])
  assert.deepEqual(
    inventoryModule.routes.map((route) => route.routePrefix),
    ['/products', '/stock', '/warehouses']
  )
  assert.equal(inventoryModule.routes.every((route) => typeof route.loadRouter === 'function'), true)
})

test('el manifiesto piloto coincide con el registro central', () => {
  const definition = MODULE_DEFINITIONS.find((module) => module.code === promotionsModule.code)
  assert.ok(definition)
  assert.deepEqual([...promotionsModule.dependencies], [...definition.dependencies])
  assert.equal(promotionsModule.routePrefix, '/promotions')
})

test('configuración permanece disponible aunque una fila haya sido alterada manualmente', () => {
  const modules = resolveEffectiveModules([
    { module_code: 'config', status: 'DISABLED' },
  ])
  const config = modules.find((module) => module.code === 'config')
  assert.equal(config.protected, true)
  assert.equal(config.status, 'ACTIVE')
  assert.equal(config.effectiveEnabled, true)
})

test('cotizaciones activas explícitamente quedan disponibles', () => {
  const quotes = resolveEffectiveModules([
    { module_code: 'quotes', status: 'ACTIVE' },
  ]).find((module) => module.code === 'quotes')

  assert.equal(quotes.status, 'ACTIVE')
  assert.equal(quotes.effectiveEnabled, true)
  assert.equal(quotes.persisted, true)
})

test('cotizaciones desactivadas quedan bloqueadas', () => {
  const quotes = resolveEffectiveModules([
    { module_code: 'quotes', status: 'DISABLED' },
  ]).find((module) => module.code === 'quotes')

  assert.equal(quotes.status, 'DISABLED')
  assert.equal(quotes.effectiveEnabled, false)
})

test('una prueba vencida de cotizaciones queda desactivada efectivamente', () => {
  const quotes = resolveEffectiveModules([
    {
      module_code: 'quotes',
      status: 'TRIAL',
      trial_ends_at: new Date('2026-01-01T00:00:00.000Z'),
    },
  ], new Date('2026-01-02T00:00:00.000Z'))
    .find((module) => module.code === 'quotes')

  assert.equal(quotes.status, 'TRIAL')
  assert.equal(quotes.effectiveEnabled, false)
})

test('cotizaciones se bloquean cuando inventario está desactivado', () => {
  const quotes = resolveEffectiveModules([
    { module_code: 'inventory', status: 'DISABLED' },
    { module_code: 'quotes', status: 'ACTIVE' },
  ]).find((module) => module.code === 'quotes')

  assert.equal(quotes.effectiveEnabled, false)
  assert.deepEqual(quotes.blockedBy, ['inventory'])
})

test('cotizaciones se bloquean cuando contactos está desactivado', () => {
  const quotes = resolveEffectiveModules([
    { module_code: 'contacts', status: 'DISABLED' },
    { module_code: 'quotes', status: 'ACTIVE' },
  ]).find((module) => module.code === 'quotes')

  assert.equal(quotes.effectiveEnabled, false)
  assert.deepEqual(quotes.blockedBy, ['contacts'])
})

test('el manifiesto de cotizaciones coincide con el registro y conserva el prefijo HTTP', () => {
  const definition = MODULE_DEFINITIONS.find((module) => module.code === quotesModule.code)
  assert.ok(definition)
  assert.deepEqual([...quotesModule.dependencies], [...definition.dependencies])
  assert.equal(quotesModule.routePrefix, '/quotes')
  assert.equal(typeof quotesModule.loadRouter, 'function')
})
