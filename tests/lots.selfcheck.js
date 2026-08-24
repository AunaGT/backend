// Self-check de la lógica FEFO pura (sin BD). Correr: node tests/lots.selfcheck.js
const assert = require('assert')
const {
  planConsume, planConsumeStrict, planRestore, fefoSort,
  createAutomaticLots, consumeLotsForLocations,
} = require('../src/services/lots')

// fefoSort: caducidad más próxima primero, sin fecha al final, desempate por recepción
const lots = [
  { id: 'c', expiry_date: null, received_at: '2026-01-01', qty_received: 10, qty_remaining: 10 },
  { id: 'a', expiry_date: '2026-08-01', received_at: '2026-02-01', qty_received: 10, qty_remaining: 4 },
  { id: 'b', expiry_date: '2026-07-10', received_at: '2026-03-01', qty_received: 10, qty_remaining: 6 },
  { id: 'd', expiry_date: '2026-07-10', received_at: '2026-01-15', qty_received: 5, qty_remaining: 5 },
].sort(fefoSort)
assert.deepStrictEqual(lots.map(l => l.id), ['d', 'b', 'a', 'c'], 'orden FEFO')

// planConsume: agota el más próximo a vencer primero y sigue con el siguiente
assert.deepStrictEqual(planConsume(lots, 8), [
  { lotId: 'd', take: 5 },
  { lotId: 'b', take: 3 },
], 'consume cruzando lotes')

// planConsume: pedir más de lo loteado se topa (stock viejo sin lote)
assert.deepStrictEqual(
  planConsume(lots, 100).reduce((s, p) => s + p.take, 0),
  25,
  'consume topa en lo disponible'
)

// planConsume: qty 0 o lotes vacíos → plan vacío
assert.deepStrictEqual(planConsume(lots, 0), [])
assert.deepStrictEqual(planConsume([], 5), [])

assert.throws(
  () => planConsumeStrict([{ id: 'a', qty_remaining: 2 }], 3, { productId: 'p', locationId: 'l' }),
  (e) => e.code === 'LOT_STOCK_MISMATCH' && e.shortfall === 1,
  'strict consumption rejects stock without matching lots'
)
assert.deepStrictEqual(
  planConsumeStrict([{ id: 'a', qty_remaining: 2 }, { id: 'b', qty_remaining: 3 }], 4),
  [{ lotId: 'a', take: 2 }, { lotId: 'b', take: 2 }]
)

// planRestore: devuelve al lote con espacio, más nuevos primero (inverso del consumo)
const consumed = [
  { id: 'x', expiry_date: '2026-07-10', received_at: '2026-01-01', qty_received: 10, qty_remaining: 0 },
  { id: 'y', expiry_date: '2026-09-01', received_at: '2026-02-01', qty_received: 10, qty_remaining: 7 },
].sort((a, b) => fefoSort(b, a)) // orden de restore: más nuevos primero
assert.deepStrictEqual(planRestore(consumed, 8), [
  { lotId: 'y', give: 3 },
  { lotId: 'x', give: 5 },
], 'restore inverso al FEFO')

// planRestore: no sobrepasa qty_received
assert.deepStrictEqual(
  planRestore(consumed, 100).reduce((s, p) => s + p.give, 0),
  13,
  'restore topa en el espacio de los lotes'
)

async function strictLocationHelpersSelfCheck() {
  const created = []
  await createAutomaticLots({
    productLot: { create: async ({ data }) => created.push(data) },
  }, 'branch', [{ product_id: 'p', location_id: 'l', qty: 2 }])
  assert.deepStrictEqual(created.map(({ product_id, branch_id, location_id, qty_received, qty_remaining, is_system_generated }) => ({
    product_id, branch_id, location_id, qty_received, qty_remaining, is_system_generated,
  })), [{
    product_id: 'p', branch_id: 'branch', location_id: 'l', qty_received: 2, qty_remaining: 2, is_system_generated: true,
  }])
  assert.match(created[0].lot_code, /^AUTO-/)

  const updates = []
  const consumed = await consumeLotsForLocations({
    productLot: {
      findMany: async () => [
        { id: 'later', product_id: 'p', location_id: 'l', qty_remaining: 2, expiry_date: new Date('2026-08-02'), received_at: new Date('2026-01-02'), lot_code: 'B', unit_cost: 2, supplier_id: null, is_system_generated: false },
        { id: 'first', product_id: 'p', location_id: 'l', qty_remaining: 2, expiry_date: new Date('2026-08-01'), received_at: new Date('2026-01-01'), lot_code: 'A', unit_cost: 1, supplier_id: 'supplier', is_system_generated: false },
      ],
      update: async ({ where, data }) => updates.push({ where, data }),
    },
  }, 'branch', [{ product_id: 'p', location_id: 'l', qty: 3 }])
  assert.deepStrictEqual(updates, [
    { where: { id: 'first' }, data: { qty_remaining: { decrement: 2 } } },
    { where: { id: 'later' }, data: { qty_remaining: { decrement: 1 } } },
  ])
  assert.deepStrictEqual(consumed.get('p').map(({ lot_code, qty }) => ({ lot_code, qty })), [
    { lot_code: 'A', qty: 2 }, { lot_code: 'B', qty: 1 },
  ])
}

strictLocationHelpersSelfCheck()
  .then(() => console.log('lots.selfcheck OK'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
