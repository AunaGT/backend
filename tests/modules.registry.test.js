const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MODULE_DEFINITIONS,
  assertRegistryValid,
  resolveEffectiveModules,
} = require('../src/modules/platform/registry')
const promotionsModule = require('../src/modules/promotions/manifest')

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

test('una prueba vencida queda desactivada efectivamente', () => {
  const modules = resolveEffectiveModules([
    {
      module_code: 'accounting',
      status: 'TRIAL',
      trial_ends_at: new Date('2026-01-01T00:00:00.000Z'),
    },
  ], new Date('2026-01-02T00:00:00.000Z'))
  assert.equal(modules.find((module) => module.code === 'accounting').effectiveEnabled, false)
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
