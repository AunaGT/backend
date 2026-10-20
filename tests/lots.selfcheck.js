// Self-check de la lógica FEFO pura (sin BD). Correr: node tests/lots.selfcheck.js
const assert = require('assert')
const { planConsume, planRestore, fefoSort } = require('../src/services/lots')

// fefoSort: caducidad más próxima primero, sin fecha al final, desempate por recepción
const lots = [
  { id: 'c', expiry_date: null, received_at: '2026-01-01', qty_received: 10, qty_remaining: 10 },
  { id: 'a', expiry_date: '2026-08-01', received_at: '2026-02-01', qty_received: 10, qty_remaining: 4 },
  { id: 'b', expiry_date: '2026-07-10', received_at: '2026-03-01', qty_received: 10, qty_remaining: 6 },
  { id: 'd', expiry_date: '2026-07-10', received_at: '2026-01-15', qty_received: 5, qty_remaining: 5 },
].sort(fefoSort)
assert.deepStrictEqual(lots.map(l => l.id), ['d', 'b', 'a', 'c'], 'orden FEFO')

// planConsume: agota el más próximo a vencer primero y sigue con el siguiente
assert.deepStrictEqual(planConsume(lots, 8), {plan:[
  { lotId: 'd', take: 5 },
  { lotId: 'b', take: 3 },
],short:0}, 'consume cruzando lotes')

// planConsume: pedir más de lo loteado se topa (stock viejo sin lote)
assert.deepStrictEqual(
  planConsume(lots, 100).plan.reduce((s, p) => s + p.take, 0),
  25,
  'consume topa en lo disponible'
)

// planConsume: qty 0 o lotes vacíos → plan vacío
assert.deepStrictEqual(planConsume(lots, 0), {plan:[],short:0})
assert.deepStrictEqual(planConsume([], 5), {plan:[],short:5})

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

console.log('lots.selfcheck OK')
