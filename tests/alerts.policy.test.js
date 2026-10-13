const test = require('node:test')
const assert = require('node:assert/strict')
const {
  availableAlertTypes,
  moduleForAlertType,
} = require('../src/modules/alerts/policy')

const modules = (...enabledCodes) => [
  'inventory', 'receivables', 'merchandise', 'orders', 'quotes', 'cash-closure', 'payroll',
].map((code) => ({ code, effectiveEnabled: enabledCodes.includes(code) }))

test('cada tipo de alerta declara el módulo que lo respalda', () => {
  assert.equal(moduleForAlertType('Stock Bajo'), 'inventory')
  assert.equal(moduleForAlertType('Cobro vencido'), 'receivables')
  assert.equal(moduleForAlertType('Pedido retrasado'), 'orders')
  assert.equal(moduleForAlertType('Tipo legado'), 'inventory')
})

test('el catálogo excluye tipos cuyo módulo está desactivado', () => {
  const types = [
    { id: 1, name: 'Stock Bajo' },
    { id: 2, name: 'Cobro vencido' },
    { id: 3, name: 'Pedido retrasado' },
  ]
  assert.deepEqual(
    availableAlertTypes(types, modules('inventory', 'orders')).map(({ id, moduleCode }) => ({ id, moduleCode })),
    [
      { id: 1, moduleCode: 'inventory' },
      { id: 3, moduleCode: 'orders' },
    ]
  )
})
