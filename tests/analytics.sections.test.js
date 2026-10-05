const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveAnalyticsSections } = require('../src/modules/analytics/sections')

const moduleState = (code, effectiveEnabled = true) => ({ code, effectiveEnabled })

test('analítica expone únicamente secciones respaldadas por módulos activos', () => {
  assert.deepEqual(resolveAnalyticsSections([
    moduleState('sales'),
    moduleState('inventory'),
    moduleState('merchandise', false),
    moduleState('receivables'),
  ]), {
    sales: true,
    products: true,
    inventory: true,
    purchases: false,
    receivables: true,
  })
})

test('productos requiere ventas e inventario efectivos', () => {
  assert.equal(resolveAnalyticsSections([
    moduleState('sales'),
    moduleState('inventory', false),
  ]).products, false)
})
