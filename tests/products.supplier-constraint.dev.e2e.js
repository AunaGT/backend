require('../src/config/loadEnv')
const test = require('node:test')
const assert = require('node:assert/strict')
const { PrismaClient } = require('@prisma/client')

// Read-only integration test: evaluate the deployed CHECK on synthetic records.
// No tenant, product, stock or payment data is inserted or updated.
test('deployed products constraint allows optional suppliers without weakening service rules', {
  skip: process.env.AUNA_PRODUCT_SUPPLIER_CONSTRAINT_TESTS !== 'approved',
}, async t => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL } } })
  const physical = { kind: 'STANDARD', supplier_id: null, stock: '30', min_stock: '10', cost: '5', tracks_expiry: false, stock_assembled: false, service_unit_label: null, quantity_decimals: 6 }
  const service = { ...physical, kind: 'SERVICE', stock: '0', min_stock: '0', cost: '0', service_unit_label: 'Hora', quantity_decimals: 2 }
  const cases = [
    ['physical product without supplier', physical, true],
    ['physical product with supplier', { ...physical, supplier_id: '00000000-0000-4000-8000-000000000001' }, true],
    ['kit without supplier', { ...physical, kind: 'KIT', quantity_decimals: 0 }, true],
    ['kit with fractional precision', { ...physical, kind: 'KIT', quantity_decimals: 1 }, false],
    ['physical product with service label', { ...physical, service_unit_label: 'Hora' }, false],
    ['physical product with excessive precision', { ...physical, quantity_decimals: 7 }, false],
    ['physical product with negative precision', { ...physical, quantity_decimals: -1 }, false],
    ['valid service', service, true],
    ['service with supplier', { ...service, supplier_id: '00000000-0000-4000-8000-000000000001' }, false],
    ['service with stock', { ...service, stock: '1' }, false],
    ['service with minimum stock', { ...service, min_stock: '1' }, false],
    ['service with cost', { ...service, cost: '1' }, false],
    ['service tracking expiry', { ...service, tracks_expiry: true }, false],
    ['assembled service', { ...service, stock_assembled: true }, false],
    ['service without unit label', { ...service, service_unit_label: null }, false],
    ['service with blank unit label', { ...service, service_unit_label: '   ' }, false],
    ['service with maximum-length unit label', { ...service, service_unit_label: 'x'.repeat(50) }, true],
    ['service with excessive precision', { ...service, quantity_decimals: 5 }, false],
  ]
  try {
    const [constraint] = await db.$queryRaw`
      SELECT pg_get_expr(conbin, conrelid) AS expression
      FROM pg_constraint
      WHERE conrelid = 'public.products'::regclass
        AND conname = 'products_service_fields_check' AND contype = 'c'
    `
    assert.ok(constraint?.expression, 'The deployed products CHECK must exist')
    // Only the database-owned expression is SQL; all fixture values are bound parameters.
    const results = await db.$queryRawUnsafe(`
      SELECT fixture->>'caseName' AS case_name, (${constraint.expression}) AS allowed
      FROM jsonb_array_elements($1::jsonb) AS fixture
      CROSS JOIN LATERAL jsonb_populate_record(NULL::public.products, fixture->'product') AS product
    `, JSON.stringify(cases.map(([caseName, product]) => ({ caseName, product }))))
    assert.equal(results.length, cases.length)
    const actual = new Map(results.map(row => [row.case_name, row.allowed]))
    for (const [name, , allowed] of cases) {
      await t.test(name, () => assert.equal(actual.get(name), allowed))
    }
    await t.test('service unit label cannot exceed the column limit', async () => {
      await assert.rejects(db.$queryRaw`
        SELECT service_unit_label FROM jsonb_populate_record(NULL::public.products,
          ${JSON.stringify({ ...service, service_unit_label: 'x'.repeat(51) })}::jsonb)
      `, error => error.meta?.code === '22001')
    })
  } finally {
    await db.$disconnect()
  }
})
