const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { nextDocumentReference } = require('../src/services/referenceGenerator')
const { allocateNetLineTotals } = require('../src/services/saleLineTotals')

test('genera referencias D por sucursal usando la tabla de devoluciones', async () => {
  const calls = []
  const tx = {
    $executeRaw: async () => {},
    return: {
      findFirst: async ({ where }) => {
        calls.push(where)
        if (typeof where.reference === 'object' && where.reference?.startsWith) return { reference: 'D-Z10-00000A' }
        return null
      },
    },
  }
  const reference = await nextDocumentReference(tx, 'D', { id: 'branch-1', code: 'Z10', seq: 2 })
  assert.equal(reference, 'D-Z10-00000B')
  assert.deepEqual(calls[0], { sale: { branch_id: 'branch-1' }, reference: { startsWith: 'D-Z10-' } })
})

test('el esquema y la migración conservan históricos con trazabilidad aditiva', () => {
  const root = path.join(__dirname, '..')
  const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8')
  const migration = fs.readFileSync(path.join(root, 'prisma/migrations/20260930120000_returns_settlement/migration.sql'), 'utf8')

  for (const fragment of [
    'enum ReturnResolution',
    'enum ReturnItemDisposition',
    'enum ReturnSettlementKind',
    'requested_resolution',
    'approved_resolution',
    'policy_override_reason',
    'replacement_sale_id',
    'net_total',
    'restock_qty',
    'model ReturnSettlement',
  ]) assert.match(schema, new RegExp(fragment))

  assert.match(migration, /CREATE TABLE "return_settlements"/)
  assert.match(migration, /ADD COLUMN\s+"requested_resolution"/)
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN/)
})

test('reparte el neto de la venta por línea sin perder centavos', () => {
  assert.deepEqual(allocateNetLineTotals([
    { qty: 1, price: 10 },
    { qty: 2, price: 10 },
    { qty: 7, price: 10 },
  ], 90), [9, 18, 63])
  const thirds = allocateNetLineTotals([
    { qty: 1, price: 1 },
    { qty: 1, price: 1 },
    { qty: 1, price: 1 },
  ], 1)
  assert.deepEqual(thirds, [0.33, 0.34, 0.33])
  assert.equal(thirds.reduce((sum, value) => sum + value, 0), 1)
})
