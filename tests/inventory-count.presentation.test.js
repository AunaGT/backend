const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET ||= 'inventory-test-only-secret-at-least-32-characters'

// Solo se sustituye el acceso a la base; el controlador y sus filtros son reales.
async function withController(prisma, run) {
  const db = require.resolve('../src/models/prisma')
  const controller = require.resolve('../src/modules/inventory-count/controller')
  const previous = require.cache[db]
  require.cache[db] = { id: db, filename: db, loaded: true, exports: { prisma } }
  delete require.cache[controller]
  try { await run(require(controller)) } finally {
    delete require.cache[controller]
    if (previous) require.cache[db] = previous
    else delete require.cache[db]
  }
}

test('buscar sesiones mantiene sucursal, aplica búsqueda en la base y pagina resultados', async () => {
  let query
  await withController({ inventoryCountSession: {
    findMany: async args => { query = args; return [] },
    count: async ({ where }) => { assert.equal(where.branch_id, 'branch-a'); return 12 },
  } }, async controller => {
    let result
    await controller.list({ branchId: 'branch-a', companyId: 'company-a', query: { q: 'mensual', status: 'IN_PROGRESS', limit: '10', offset: '10' } }, { json: value => { result = value } }, err => { throw err })
    assert.equal(query.where.OR?.[0]?.name?.contains, 'mensual')
    assert.equal(query.where.status, 'IN_PROGRESS')
    assert.equal(query.take, 10)
    assert.equal(query.skip, 10)
    assert.equal(result.total, 12)
  })
})

test('resumen distingue cero contado de pendiente y contabiliza diferencias reales', async () => {
  await withController({ inventoryCountSession: { findFirst: async () => ({ id: 's', scope_json: {}, _count: { lines: 4 } }) }, inventoryCountLine: {
    count: async () => 3,
    aggregate: async () => ({ _sum: { stock_snapshot: 20 } }),
    findMany: async () => [
      { stock_snapshot: 5, qty_counted: 5, product: { cost: 2 } },
      { stock_snapshot: 5, qty_counted: 0, product: { cost: 2 } },
      { stock_snapshot: 5, qty_counted: 7, product: { cost: 2 } },
    ],
  } }, async controller => {
    let result
    await controller.getById({ params: { id: 's' }, companyId: 'c' }, { json: value => { result = value } }, err => { throw err })
    assert.equal(result.progress.pct, 75)
    assert.deepEqual(result.totals, { sumStockSnapshot: 20, valueDeltaApprox: -6, unchangedLines: 1, differenceLines: 2, notFoundLines: 1, mismatchLines: 0 })
  })
})

test('cantidades inválidas no se convierten silenciosamente en un conteo de cero', async () => {
  const line = { qty_counted: 0, qty_counted_secondary: null, stock_snapshot: 5, product: { cost: 2 } }
  await withController({ inventoryCountSession: { findFirst: async () => ({ status: 'IN_PROGRESS', scope_json: { doubleCount: true } }) }, inventoryCountLine: { findFirst: async () => line, update: async () => line } }, async controller => {
    for (const qty of ['', -1, 1.5, Infinity, 'abc', false]) {
      let status = 200
      await controller.updateLine({ params: { id: 's', lineId: 'l' }, user: { id: 'u' }, companyId: 'c', body: { qty_counted: qty } }, { json: () => {}, status: code => { status = code; return { json: () => {} } } }, err => { throw err })
      assert.equal(status, 400, `debe rechazar ${String(qty)}`)
    }
  })
})

test('un conteo guardado en una sesión grande muestra avance y no cero por redondeo', async () => {
  await withController({ inventoryCountSession: { findFirst: async () => ({ id: 's', scope_json: {}, _count: { lines: 211 } }) }, inventoryCountLine: {
    count: async () => 1, aggregate: async () => ({ _sum: { stock_snapshot: 0 } }), findMany: async () => [],
  } }, async controller => {
    let result
    await controller.getById({ params: { id: 's' }, companyId: 'c' }, { json: value => { result = value } }, err => { throw err })
    assert.equal(result.progress.pct, 0.5)
  })
})
