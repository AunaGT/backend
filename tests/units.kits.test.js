const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const model = require.resolve('../src/models/prisma')
const target = require.resolve('../src/modules/inventory/products.controller')
const dec = value => new Prisma.Decimal(value ?? 0)

function fixture({ enabled = true, configured = true, shortLots = false } = {}) {
  const catalog = {
    c: { id: 'c', company_id: 'A', kind: 'STANDARD', name: 'Componente', unit_metadata_version:configured?2:1, quantity_decimals: 6, base_unit_id: configured ? 'kg' : null, tracks_expiry: true },
    k: { id: 'k', company_id: 'A', kind: 'KIT', name: 'Kit', quantity_decimals: 0, stock_assembled: true, tracks_expiry: false, kit_components: [{ component_product_id: 'c', qty_per_unit: '0.25' }] },
  }
  const state = {
    stock: { c: '2', k: '2' }, cost: { c: '8', k: '10' },
    locations: { 'c|L1': '0.25', 'c|L2': '1.75', 'k|KITLOC': '2' }, reservations: {},
    lots: [
      { id: 'la', product_id: 'c', location_id: 'L1', qty_received: '0.25', qty_remaining: '0.25', lot_code: 'A', unit_cost: '5', supplier_id: null, expiry_date: new Date('2027-01-01'), received_at: new Date('2026-01-01') },
      { id: 'lb', product_id: 'c', location_id: 'L2', qty_received: '1.75', qty_remaining: shortLots ? '0' : '1.75', lot_code: 'B', unit_cost: '7', supplier_id: null, expiry_date: new Date('2027-02-01'), received_at: new Date('2026-01-01') },
    ], movements: [], writes: 0,
  }
  const held = new Map()
  const match = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (key === 'branch') return value.company_id === 'A'
    if (key === 'AND') return value.every(filter => match(row, filter))
    if (value && typeof value === 'object') {
      if (value.in) return value.in.includes(row[key])
      if (value.gt != null) return dec(row[key]).gt(value.gt)
      if (value.lt != null) return dec(row[key]).lt(value.lt)
      if (value.not != null) return row[key] !== value.not
    }
    return row[key] === value
  })
  function client(transaction = false) {
    let before = null
    const releases = []
    const write = () => { assert(transaction, 'Writes must use the caller transaction'); before ||= structuredClone(state); state.writes++ }
    const product = id => catalog[id] && { ...structuredClone(catalog[id]), stock: state.stock[id], cost: state.cost[id], min_stock: 0, branch_stocks: [{ stock: state.stock[id] }] }
    const db = {
      branch: { findFirst: async ({ where }) => where.id === 'B' && where.company_id === 'A' ? { id: 'B' } : null },
      systemSetting: { findUnique: async ({ where }) => ({ key: where.company_id_key.key, value: enabled ? 'true' : 'false' }) },
      product: {
        findFirst: async ({ where }) => product(where.id) && (!where.company_id || where.company_id === 'A') && (!where.kind || where.kind === catalog[where.id].kind) ? product(where.id) : null,
        findUnique: async ({ where }) => product(where.id),
        findMany: async ({ where }) => Object.keys(catalog).filter(id => where.id.in.includes(id) && (!where.tracks_expiry || catalog[id].tracks_expiry)).map(product),
        update: async ({ where, data }) => { write(); if (data.cost != null) state.cost[where.id] = String(data.cost); Object.assign(catalog[where.id], Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'cost'))); return product(where.id) },
      },
      productStock: { findMany: async ({ where }) => where.product_id.in.map(product_id => ({ product_id, stock: state.stock[product_id] })) },
      productStockLocation: { findMany: async ({ where }) => Object.entries(state.locations).map(([key, stock]) => { const [product_id, location_id] = key.split('|'); return { product_id, location_id, stock } }).filter(row => match(row, where)) },
      stockReservation: { findMany: async ({ where }) => Object.entries(state.reservations).filter(([id]) => where.product_id.in.includes(id)).map(([product_id, qty]) => ({ product_id, qty })) },
      measureUnit: { findFirst: async () => ({ id: 'kg', code: 'KG', name: 'Kilogramo', label: 'kg' }) },
      productLot: {
        findMany: async ({ where }) => state.lots.filter(row => match({ ...row, branch_id: 'B' }, where)).map(row => ({ ...row })),
        update: async ({ where, data }) => { write(); const lot = state.lots.find(row => row.id === where.id); lot.qty_remaining = dec(lot.qty_remaining).sub(data.qty_remaining.decrement).toFixed(); return lot },
        create: async ({ data }) => { write(); const lot = { id: `restored-${state.lots.length}`, ...data }; state.lots.push(lot); return lot },
      },
      stockMovement: {
        findMany: async ({ where, take, skip = 0 } = {}) => { const rows = state.movements.filter(row => match(row, where)); return rows.slice(skip, take == null ? undefined : skip + take).map(row => structuredClone(row)) },
        count: async ({ where }) => state.movements.filter(row => match(row, where)).length,
        createMany: async ({ data }) => { write(); for (const row of data) state.movements.push({ id: `m${state.movements.length}`, created_at: new Date('2026-10-17'), ...structuredClone(row) }) },
      },
      status: { findFirst: async () => null }, alertType: { findMany: async () => [] }, alertPriority: { findMany: async () => [] },
      $executeRaw: async (sql, ...values) => {
        if (String(sql).includes('pg_advisory_xact_lock')) {
          assert(transaction)
          const key = String(values[0]), prior = held.get(key) || Promise.resolve()
          let release; const next = new Promise(resolve => { release = resolve }); held.set(key, next)
          await prior; releases.push(release)
        }
        return 1
      },
      $queryRaw: async (sql, ...args) => {
        const s = String(sql), values = args.flatMap(value => value?.values || [])
        if (s.includes('SELECT l.id')) return s.includes('LIMIT 1') ? [{id:'KITLOC'}] : values.filter(id=>['KITLOC','L1','L2','OTHER'].includes(id)).map(id=>({id}))
        if (s.includes('SELECT psl.product_id')) return Object.entries(state.locations).filter(([key, stock]) => key.startsWith('c|') && dec(stock).gt(0)).map(([key, stock]) => ({ product_id: 'c', location_id: key.split('|')[1], stock }))
        if (s.includes('FOR UPDATE OF ps')) return values.filter(id => catalog[id]).map(id => ({ ...product(id), deleted: false }))
        if (s.includes('UPDATE product_stock_locations')) {
          write(); const rows = []
          for (let i = 0; i < values.length; i += 3) { const [product_id, location_id, qty] = values.slice(i, i + 3), key = `${product_id}|${location_id}`; state.locations[key] = dec(state.locations[key]).add(qty).toFixed(); rows.push({ product_id, location_id, qty, balance: state.locations[key] }) }
          return rows
        }
        if (s.includes('UPDATE product_stocks')) { write(); const [id, qty] = values; state.stock[id] = dec(state.stock[id]).add(qty).toFixed(); return [{ id, stock: state.stock[id], min_stock: 0 }] }
        throw Error('Unexpected SQL ' + s)
      },
      finish: error => { if (error && before) Object.assign(state, before); for (const release of releases) release() },
    }
    return db
  }
  const db = client()
  db.$transaction = async fn => { const tx = client(true); try { const result = await fn(tx); tx.finish(); return result } catch (error) { tx.finish(error); throw error } }
  const request = (body, overrides = {}) => ({ params: { id: 'k' }, companyId: 'A', branchId: 'B', user: { sub: 'U', permissions: ['products.edit'] }, body, ...overrides })
  const run = fn => withMocks({ [model]: { prisma: db, prismaTransaction: db } }, target, controller => fn(async (name, body, overrides) => { const res = jsonResponse(); await controller[name](request(body, overrides), res, error => { throw error }); return res.body }))
  return { db, state, catalog, request, run }
}

test('assembly transfers company-average component value into the weighted finished-kit cost', async () => {
  const f = fixture()
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    assert.deepEqual(f.state.stock, { c: '1.5', k: '4' })
    assert.equal(f.state.cost.k, '6.000000000000')
    const rows = f.state.movements.filter(row => row.group_id === event.assembly_group_id)
    assert.deepEqual(rows.filter(row => row.qty < 0).map(row => row.unit_snapshot.assembly.value), ['2', '2'])
    assert.equal(rows.find(row => row.product_id === 'k').unit_snapshot.assembly.value, '4')
    assert.equal(rows.find(row => row.product_id === 'k').unit_snapshot.assembly.unit_cost, '2.000000000000')
    assert.equal(dec(f.state.stock.c).mul(f.state.cost.c).add(dec(f.state.stock.k).mul(f.state.cost.k)).toFixed(), '36')
  })
})

test('disassembly restores original locations, lots and frozen values after BOM and component-cost edits', async () => {
  const f = fixture()
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    f.catalog.k.kit_components = [{ component_product_id: 'now-different', qty_per_unit: 99 }]
    f.state.cost.c = '4'
    const result = await call('disassembleKit', { assembly_group_id: event.assembly_group_id })
    assert.deepEqual(f.state.stock, { c: '2', k: '2' })
    assert.equal(f.state.cost.c, '5.000000000000'); assert.equal(f.state.cost.k, '10.000000000000')
    assert.equal(f.state.locations['c|L1'], '0.25'); assert.equal(f.state.locations['c|L2'], '1.75')
    assert.deepEqual(f.state.lots.slice(2).map(lot => [lot.location_id, String(lot.qty_remaining), String(lot.unit_cost), lot.lot_code]), [['L1', '0.25', '5', 'A'], ['L2', '0.25', '7', 'B']])
    assert.equal(result.qty, '2'); assert.equal(result.assembly_group_id, event.assembly_group_id)
    assert.equal(dec(f.state.stock.c).mul(f.state.cost.c).add(dec(f.state.stock.k).mul(f.state.cost.k)).toFixed(), '30')
    const before = structuredClone(f.state)
    assert.deepEqual(await call('disassembleKit', { assembly_group_id: event.assembly_group_id }), result)
    assert.deepEqual(f.state, before)
  })
})

test('concurrent disassembly requests share one persisted reversal without double restoration', async () => {
  const f = fixture()
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    const results = await Promise.all([call('disassembleKit', { assembly_group_id: event.assembly_group_id }), call('disassembleKit', { assembly_group_id: event.assembly_group_id })])
    assert.deepEqual(results[0], results[1])
    assert.deepEqual(f.state.stock, { c: '2', k: '2' })
    assert.equal(new Set(f.state.movements.filter(row => row.reason === 'KIT_DISASSEMBLE').map(row => row.group_id)).size, 1)
    assert.equal(f.state.lots.length, 4)
  })
})

test('equivalent uppercase event IDs share the same reversal claim and result', async () => {
  const f = fixture()
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    const results = await Promise.all([call('disassembleKit', { assembly_group_id: event.assembly_group_id.toUpperCase() }), call('disassembleKit', { assembly_group_id: event.assembly_group_id })])
    assert.deepEqual(results[0], results[1])
    assert.deepEqual(f.state.stock, { c: '2', k: '2' })
  })
})

for (const [name, change, code] of [
  ['reserved kits', f => { f.state.reservations.k = '3' }, 'KIT_ASSEMBLY_STOCK_REQUIRED'],
  ['kits moved from the original location', f => { f.state.locations['k|KITLOC'] = '1'; f.state.locations['k|OTHER'] = '3' }, 'KIT_ASSEMBLY_STOCK_REQUIRED'],
  ['incompatible current valuation', f => { f.state.cost.k = '0' }, 'KIT_ASSEMBLY_VALUATION_CONFLICT'],
  ['a remaining average beyond the storage range', f => { f.state.cost.k = '999999999999' }, 'KIT_ASSEMBLY_VALUATION_CONFLICT'],
  ['incomplete old snapshots', f => { delete f.state.movements[0].unit_snapshot.assembly }, 'KIT_ASSEMBLY_SNAPSHOT_REQUIRED'],
  ['missing frozen cost fields', f => { delete f.state.movements[0].unit_snapshot.assembly.unit_cost }, 'KIT_ASSEMBLY_SNAPSHOT_REQUIRED'],
]) test(`disassembly rejects ${name} without changing stock, lots or history`, async () => {
  const f = fixture()
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' }); change(f)
    const before = structuredClone(f.state)
    await assert.rejects(call('disassembleKit', { assembly_group_id: event.assembly_group_id }), error => error.status === 409 && error.code === code)
    assert.deepEqual(f.state, before)
  })
})

test('assembly and reversal scope company, branch and product before mutations', async () => {
  const f = fixture()
  await f.run(async call => {
    for (const override of [{ companyId: 'foreign' }, { branchId: 'foreign' }, { params: { id: 'unknown' } }]) {
      const before = structuredClone(f.state)
      await assert.rejects(call('assembleKit', { qty: '2' }, override), error => error.status === 404)
      assert.deepEqual(f.state, before)
    }
    const event = await call('assembleKit', { qty: '2' })
    for (const override of [{ companyId: 'foreign' }, { branchId: 'foreign' }, { params: { id: 'c' } }]) {
      const before = structuredClone(f.state)
      await assert.rejects(call('disassembleKit', { assembly_group_id: event.assembly_group_id }, override), error => error.status === 404)
      assert.deepEqual(f.state, before)
    }
    await assert.rejects(call('disassembleKit', { assembly_group_id: '00000000-0000-4000-8000-000000000000' }), error => error.status === 404)
    await assert.rejects(call('disassembleKit', { assembly_group_id: event.assembly_group_id, qty: '1' }), error => error.status === 400)
  })
})

test('tracked component lot shortages roll back the assembly valuation as well as stock', async () => {
  const f = fixture({ shortLots: true }), before = structuredClone(f.state)
  await f.run(async call => { await assert.rejects(call('assembleKit', { qty: '2' }), error => error.status === 409); assert.deepEqual(f.state, before) })
})

test('tracked finished-kit lot shortages roll back disassembly stock, costs and its claim', async () => {
  const f = fixture(); f.catalog.k.tracks_expiry = true
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    const batch = f.state.lots.find(lot => lot.product_id === 'k')
    assert.equal(String(batch.unit_cost), '2.000000000000')
    batch.qty_remaining = '0'
    const before = structuredClone(f.state)
    await assert.rejects(call('disassembleKit', { assembly_group_id: event.assembly_group_id }), error => error.status === 409)
    assert.deepEqual(f.state, before)
  })
})

test('flag-off old-client assemblies remain valued but cannot invent missing reversal snapshots', async () => {
  const f = fixture({ enabled: false, configured: false })
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    assert.equal(f.state.cost.k, '6.000000000000')
    assert(f.state.movements.every(row => !Object.hasOwn(row, 'unit_snapshot')))
    const before = structuredClone(f.state)
    await assert.rejects(call('disassembleKit', { assembly_group_id: event.assembly_group_id }), error => error.code === 'KIT_ASSEMBLY_SNAPSHOT_REQUIRED' && error.status === 409)
    assert.deepEqual(f.state, before)
  })
})

test('assembly keeps eighteen-place values and reversal admits only bounded average-cost quantization residue', async () => {
  const f = fixture()
  f.state.stock.k = '0'; f.state.locations['k|KITLOC'] = '0'; f.state.cost.k = '0'
  f.state.cost.c = '1.000001000001'; f.catalog.k.kit_components[0].qty_per_unit = '0.333333'
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '3' })
    const kitRow = f.state.movements.find(row => row.product_id === 'k')
    assert.equal(kitRow.unit_snapshot.assembly.value, '0.999999999999999999')
    assert.equal(f.state.cost.k, '0.333333333333')
    f.state.cost.k = '0.333333333332'
    const before = structuredClone(f.state)
    await assert.rejects(call('disassembleKit', { assembly_group_id: event.assembly_group_id }), error => error.code === 'KIT_ASSEMBLY_VALUATION_CONFLICT')
    assert.deepEqual(f.state, before)
    f.state.cost.k = '0.333333333333'
    const reversal = await call('disassembleKit', { assembly_group_id: event.assembly_group_id })
    assert.equal(reversal.value, '0.999999999999999999')
    assert.deepEqual(f.state.stock, { c: '2', k: '0' })
    assert.equal(f.state.cost.c, '1.000001000001')
  })
})

test('kit routes use edit permission for changes and view permission for event selection', async () => {
  const f = fixture()
  await withMocks({ [model]: { prisma: f.db, prismaTransaction: f.db } }, require.resolve('../src/modules/inventory/products.routes'), async router => {
    for (const [path, method, permission, denied] of [
      ['/:id/kit/assemble', 'post', 'products.edit', 'products.view'],
      ['/:id/kit/disassemble', 'post', 'products.edit', 'products.view'],
      ['/:id/kit/assemblies', 'get', 'products.view', 'products.edit'],
    ]) {
      const route = router.stack.find(layer => layer.route?.path === path)?.route
      assert(route?.methods[method], `Missing ${method} ${path}`)
      for (const [grant, expected] of [[permission, 200], [denied, 403]]) {
        const res = jsonResponse(); res.send = value => { res.body = value; return res }
        let admitted = false
        route.stack[1].handle({ user: { permissions: [grant] } }, res, () => { admitted = true })
        assert.equal(res.statusCode, expected); assert.equal(admitted, expected === 200)
      }
    }
  })
})

test('assembly event query exposes frozen quantities, values and reversal status in the active scope', async () => {
  const f = fixture()
  await f.run(async call => {
    const event = await call('assembleKit', { qty: '2' })
    let list = await call('listKitAssemblies', {}, { query: {} })
    assert.equal(list.items[0].assembly_group_id, event.assembly_group_id)
    assert.equal(list.items[0].status, 'READY'); assert.equal(list.items[0].qty, '2'); assert.equal(list.items[0].value, '4')
    assert.deepEqual(list.items[0].components.map(row => [row.location_id, row.qty, row.value]), [['L1', '0.25', '2'], ['L2', '0.25', '2']])
    await call('disassembleKit', { assembly_group_id: event.assembly_group_id })
    list = await call('listKitAssemblies', {}, { query: {} })
    assert.equal(list.items[0].status, 'REVERSED'); assert.match(list.items[0].reversal_group_id, /^[0-9a-f-]{36}$/)
    await assert.rejects(call('listKitAssemblies', {}, { query: {}, companyId: 'foreign' }), error => error.status === 404)
  })
})
