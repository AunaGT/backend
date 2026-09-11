const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MODULE_DEFINITIONS,
  assertRegistryValid,
  resolveEffectiveModules,
} = require('../src/modules/platform/registry')
const promotionsModule = require('../src/modules/promotions/manifest')
const inventoryModule = require('../src/modules/inventory/manifest')

test('el registro no contiene dependencias inexistentes ni circulares', () => {
  assert.equal(assertRegistryValid(), true)
  assert.equal(new Set(MODULE_DEFINITIONS.map((module) => module.code)).size, MODULE_DEFINITIONS.length)
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
