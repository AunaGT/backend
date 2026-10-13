const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')
const { commercialQuantity, parseCatalogKind, lineSnapshot, assertPhysicalItem, assertServiceFields, assertServicesEnabled } = require('../src/services/catalogItemRules')
const { allocateNetLineTotals } = require('../src/services/saleLineTotals')
const service = { kind: 'SERVICE', quantity_decimals: 3 }

test('preserves fractions and accepts trailing zeros without rounding excessive precision', () => {
  assert.equal(commercialQuantity('0.1250', service).toString(), '0.125')
  assert.equal(commercialQuantity(new Prisma.Decimal('1.5'), service).toString(), '1.5')
  assert.throws(() => commercialQuantity('0.1251', service), /decimales/i)
  for (const kind of ['STANDARD', 'KIT']) assert.throws(() => commercialQuantity('1.5', { kind }))
  assert.equal(commercialQuantity(2, { kind: 'STANDARD' }).toString(), '2')
})
test('rejects invalid, noncanonical and out-of-range quantities before persistence', () => {
  for (const raw of ['', null, undefined, {}, [], NaN, Infinity, '-1', '0', '1,5', '1e2', '100000000', '1'.repeat(129)]) {
    assert.throws(() => commercialQuantity(raw, service), String(raw))
  }
  assert.throws(() => commercialQuantity(1.5, service), /cadena/i)
  assert.equal(commercialQuantity('0', service, { allowZero: true }).toString(), '0')
  assert.equal(commercialQuantity('99999999.9999', { ...service, quantity_decimals: 4 }).toString(), '99999999.9999')
  assert.throws(() => commercialQuantity('1', { ...service, quantity_decimals: 5 }))
})
test('never normalizes an unknown catalog kind to a physical good', () => {
  assert.equal(parseCatalogKind(undefined), 'STANDARD')
  assert.equal(parseCatalogKind('service'), 'SERVICE')
  assert.throws(() => parseCatalogKind('invented'))
})
test('captures service unit and precision and blocks physical fields on services', () => {
  const product = { ...service, name: 'Asesoría', service_unit_label: 'Hora' }
  assert.deepEqual(lineSnapshot(product), { item_name: 'Asesoría', item_kind: 'SERVICE', unit_label: 'Hora', quantity_decimals: 3 })
  assert.deepEqual(lineSnapshot({ name: 'Botella', kind: 'STANDARD' }), { item_name: 'Botella', item_kind: 'STANDARD', unit_label: 'unidad', quantity_decimals: 0 })
  assert.throws(() => assertPhysicalItem(product), /servicio/i)
  assertServiceFields({ service_unit_label: 'Hora', quantity_decimals: 2 })
  for (const field of ['stock', 'min_stock', 'cost', 'supplier_id', 'tracks_expiry', 'stock_assembled', 'kit_components', 'warehouse_id', 'location_id']) {
    assert.throws(() => assertServiceFields({ service_unit_label: 'Hora', quantity_decimals: 2, [field]: 1 }), field)
  }
  assert.throws(() => assertServiceFields({ service_unit_label: ' ', quantity_decimals: 2 }))
})
test('service setting is scoped and absent or false does not enable sales', async () => {
  const seen = []
  const tx = { systemSetting: { findUnique: async query => { seen.push(query.where); return { value: 'true' } } } }
  await assertServicesEnabled(tx, 'company-A')
  assert.deepEqual(seen, [{ company_id_key: { company_id: 'company-A', key: 'inventory_services_enabled' } }])
  for (const value of [null, { value: 'false' }, { value: 'yes' }]) {
    await assert.rejects(assertServicesEnabled({ systemSetting: { findUnique: async () => value } }, 'A'), error => error.status === 403)
  }
})
test('allocation preserves fractional gross weights and final cent residual', () => {
  assert.deepEqual(allocateNetLineTotals([{ price: '19.99', qty: '1.25' }], '24.99'), [24.99])
  assert.deepEqual(allocateNetLineTotals([{ price: '100', qty: '0.125' }, { price: '100', qty: '0.125' }], '24.99'), [12.5, 12.49])
  assert.throws(() => allocateNetLineTotals([{ price: 1, qty: 1 }], '-1'))
  assert.throws(() => allocateNetLineTotals([{ price: 1, qty: 1 }], '10000000000'))
})
