const test = require('node:test')
const assert = require('node:assert/strict')
const { withStockUnits } = require('../src/modules/inventory/warehouses.presentation')

test('suma existencias reales por almacén sin fabricar capacidad', () => {
  const rows = [{ id: 'a', locations: [{ id: 'x' }, { id: 'y' }] }, { id: 'b', locations: [{ id: 'z' }] }]
  const totals = [{ location_id: 'x', _sum: { stock: 4 } }, { location_id: 'y', _sum: { stock: 7 } }]
  assert.deepEqual(withStockUnits(rows, totals).map((row) => row.stock_units), [11, 0])
  assert.equal(rows[0].stock_units, undefined)
})
