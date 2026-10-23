const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma: { Decimal } } = require('@prisma/client')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const model = require.resolve('../src/models/prisma')

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every(part => matches(row, part))
    if (key === 'OR') return value.some(part => matches(row, part))
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key])
      if ('contains' in value) return String(row[key] ?? '').toLowerCase().includes(value.contains.toLowerCase())
      if ('some' in value) return (row[key] ?? []).some(item => matches(item, value.some))
      if (['gt', 'gte', 'lt', 'lte'].some(operator => operator in value)) return (!('gte' in value) || row[key] >= value.gte) && (!('gt' in value) || row[key] > value.gt) && (!('lte' in value) || row[key] <= value.lte) && (!('lt' in value) || row[key] < value.lt)
      return !!row[key] && matches(row[key], value)
    }
    return row[key] === value
  })
}

function stockFixture({ held = false } = {}) {
  const calls = [], gates = [], responses = []
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: String(index), branch_id: 'B', product_id: 'P', location_id: 'L', group_id: 'G', reason: 'INTERNAL_MOVE', notes: 'Cafe', created_at: new Date('2026-10-01T12:00:00Z'),
    qty: new Decimal(index < 4 ? '0.125' : index < 8 ? '-0.125' : '0'), balance: new Decimal('2.000001'),
    product: { id: 'P', name: 'Cafe', barcode: '001' }, location: { id: 'L', code: 'L', warehouse: { name: 'Bodega' } }, createdBy: { id: 'U', name: 'Persona' } }))
  rows.push({ ...rows[0], id: 'FOREIGN', branch_id: 'OTHER' })
  let automatic = !held, active = 0, maximum = 0
  const db = { systemSetting: { findMany: async () => [] }, stockMovement: {
    count: async query => {
      const sign = query.where.AND?.[1]?.qty, type = sign?.gt !== undefined ? 'incoming' : sign?.lt !== undefined ? 'outgoing' : 'total'
      calls.push({ method: 'count', type, ...query }); active++; maximum = Math.max(maximum, active)
      try {
        if (!automatic) await new Promise((resolve, reject) => gates.push({ type, resolve, reject }))
        return rows.filter(row => matches(row, query.where)).length
      } finally { active-- }
    },
    findMany: async query => {
      calls.push({ method: 'page', ...query })
      return rows.filter(row => matches(row, query.where)).sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id)).slice(query.skip ?? 0, (query.skip ?? 0) + query.take)
    },
  } }
  const run = (query, scope = {}) => withMocks({ [model]: { prisma: db } }, require.resolve('../src/modules/inventory/stock.controller'), async controller => {
    const res = jsonResponse(); responses.push(res)
    await controller.list({ companyId: 'A', branchId: 'B', query, ...scope }, res, error => { throw error })
    return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body)) }
  })
  return { run, calls, rows, gates, responses, get maximum() { return maximum }, release() { automatic = true; gates.forEach(gate => gate.resolve()) } }
}

test('stock summary starts three independent counts before awaiting any, then reads one correctly scoped page', async () => {
  const f = stockFixture({ held: true }), pending = f.run({ page: '999', pageSize: '2', includeSummary: 'true', product_id: 'P', location_id: 'L', group_id: 'G', reason: 'INTERNAL_MOVE', search: ' Cafe ', from: '2026-10-01', to: '2026-10-01' })
  try {
    await new Promise(setImmediate)
    assert.deepEqual(f.calls.map(call => call.type), ['total', 'incoming', 'outgoing'])
    assert.equal(f.maximum, 3); assert.equal(f.calls.some(call => call.method === 'page'), false)
    f.gates.filter(gate => gate.type !== 'total').forEach(gate => gate.resolve()); await new Promise(setImmediate)
    assert.equal(f.calls.some(call => call.method === 'page'), false)
    f.release(); const { body } = await pending
    assert.deepEqual(body.summary, { total: 9, incoming: 4, outgoing: 4 }); assert.equal(body.page, 5); assert.equal(body.totalPages, 5)
    assert.equal(body.items[0].qty, '0.125'); assert.equal(body.items[0].balance, '2.000001'); assert.equal(body.items[0].id, '0')
    const [total, incoming, outgoing, page] = f.calls
    assert.equal(f.calls.length, 4); assert.deepEqual(incoming.where, { AND: [total.where, { qty: { gt: 0 } }] }); assert.deepEqual(outgoing.where, { AND: [total.where, { qty: { lt: 0 } }] }); assert.deepEqual(page.where, total.where)
    assert.equal(total.where.branch_id, 'B'); assert.equal(total.where.product_id, 'P'); assert.equal(total.where.location_id, 'L'); assert.equal(total.where.group_id, 'G'); assert.equal(total.where.reason, 'INTERNAL_MOVE')
    assert.equal(total.where.created_at.gte.toISOString(), '2026-10-01T06:00:00.000Z'); assert.equal(total.where.created_at.lt.toISOString(), '2026-10-02T06:00:00.000Z')
    assert.equal(total.where.OR[0].product.name.contains, 'Cafe'); assert.deepEqual(page.orderBy, [{ created_at: 'desc' }, { id: 'desc' }]); assert.equal(page.skip, 8); assert.equal(page.take, 2)
  } finally { f.release(); await pending.catch(() => {}) }
})

test('a failed parallel stock count cannot publish a partial summary or start a page read', async () => {
  const f = stockFixture({ held: true }), pending = f.run({ page: '1', includeSummary: 'true' })
  try {
    await new Promise(setImmediate)
    assert.equal(f.gates.length, 3)
    const error = Error('count unavailable'); f.gates.find(gate => gate.type === 'incoming').reject(error)
    await assert.rejects(pending, actual => actual === error)
    assert.equal(f.responses[0].body, null); assert.equal(f.calls.some(call => call.method === 'page'), false)
  } finally { f.release(); await pending.catch(() => {}) }
})

test('stock signs include neutral rows only in the total and preserve decimal entries, exits and balances', async () => {
  const f = stockFixture(), { body } = await f.run({ page: '1', pageSize: '100', includeSummary: 'true' })
  assert.deepEqual(body.summary, { total: 9, incoming: 4, outgoing: 4 }); assert.equal(body.items.length, 9)
  assert.equal(body.items.filter(row => row.qty === '0.125').length, 4); assert.equal(body.items.filter(row => row.qty === '-0.125').length, 4); assert.equal(body.items.filter(row => row.qty === '0').length, 1)
  assert.ok(body.items.every(row => row.balance === '2.000001'))
  const empty = await f.run({ page: '99', includeSummary: 'true', product_id: 'MISSING' }); assert.equal(empty.body.page, 1); assert.deepEqual(empty.body.summary, { total: 0, incoming: 0, outgoing: 0 }); assert.deepEqual(empty.body.items, [])
})

test('stock no-summary, legacy limits and rejected filters do not gain extra counting work', async () => {
  const f = stockFixture()
  let result = await f.run({ page: '1', pageSize: '2' }); assert.equal(result.body.summary, undefined); assert.deepEqual(f.calls.map(call => call.method), ['count', 'page'])
  f.calls.length = 0; result = await f.run({ limit: '9999', includeSummary: 'true' }); assert.ok(Array.isArray(result.body)); assert.equal(result.body.length, 9); assert.deepEqual(f.calls.map(call => call.method), ['page']); assert.equal(f.calls[0].take, 500)
  f.calls.length = 0; await f.run({ limit: '-1' }); assert.equal(f.calls[0].take, 100)
  for (const query of [{ page: '1', reason: 'INVALID' }, { page: '1', from: 'bad' }, { page: '1', from: '2026-10-03', to: '2026-10-01' }]) {
    f.calls.length = 0; result = await f.run(query); assert.equal(result.status, 400); assert.deepEqual(f.calls, [])
  }
  f.calls.length = 0; await assert.rejects(f.run({ page: '1' }, { branchId: null }), error => error.status === 400); assert.deepEqual(f.calls, [])
})

function documentFixture(kind) {
  const merchandise = kind === 'merchandise', table = merchandise ? 'incomingMerchandise' : 'stockTransfer'
  const field = merchandise ? 'payment_status' : 'status'
  const statuses = merchandise ? ['PAID', 'PARTIAL', 'PENDING'] : ['EN_TRANSITO', 'RECIBIDA', 'CANCELADA']
  const snapshot = { version: 2, baseUnit: { id: 'UNIT', label: 'ud', decimals: 0 }, presentation: { id: 'PACK', label: 'caja', version: 1, decimals: 0 }, factor: '24', roundingDelta: '0' }
  const rows = Array.from({ length: 9 }, (_, index) => ({
    id: String(index).padStart(2, '0'), source:'PURCHASE', [field]: statuses[index % 3], branch_id: 'B', from_branch_id: 'B', to_branch_id: 'D',
    fromBranch: { id: 'B', name: 'Origen', company_id: 'A' }, toBranch: { id: 'D', name: 'Destino', company_id: 'A' },
    reference: 'TR-Cafe', supplier_id: 'S', supplier: { id: 'S', name: 'Cafe', contact: 'Contacto' }, registeredBy: { id: 'U', name: 'Persona', email: 'qa@example.test' },
    notes: 'Cafe', date: new Date('2026-10-01T12:00:00Z'), sent_at: new Date('2026-10-01T12:00:00Z'), paymentTerm: null,
    items: [{ id: 'ITEM', product: { id: 'P', name: 'Cafe', brand: 'Marca', size: '24', barcode: '001' }, quantity: new Decimal(index ? '3' : '2'), unit_cost: new Decimal(index ? '10' : '120.000001'),
      ...(index ? {} : { unit_metadata_version: 2, unit_snapshot: snapshot, base_qty: new Decimal('48'), base_unit_cost: new Decimal('5.000000041667'), line_total: new Decimal('240.00') }) }],
    lines: [{ id: 'LINE', product_id: 'P', product: { id: 'P', name: 'Cafe', barcode: '001', image_url: '/cafe.png' }, qty_sent: new Decimal('1.125'), qty_received: new Decimal('0.125') }],
  }))
  rows.push({ ...rows[0], id: 'OUT', branch_id: 'C', from_branch_id: 'C', to_branch_id: 'D', fromBranch: { company_id: 'A', name: 'Otra' } })
  rows.push({ ...rows[0], id: 'FOREIGN', branch_id: 'Z', from_branch_id: 'Z', to_branch_id: 'Z', fromBranch: { company_id: 'OTHER', name: 'Ajena' } })
  const calls = [], db = { [table]: {
    count: async query => { calls.push({ method: 'count', ...query }); return rows.filter(row => matches(row, query.where)).length },
    groupBy: async query => {
      calls.push({ method: 'groupBy', ...query })
      const groups = new Map()
      for (const row of rows.filter(row => matches(row, query.where))) {const values=Object.fromEntries(query.by.map(key=>[key,row[key]])),key=JSON.stringify(values),old=groups.get(key);groups.set(key,{...values,_count:{_all:(old?._count._all??0)+1}})}
      return [...groups.values()]
    },
    findMany: async query => {
      calls.push({ method: 'page', ...query })
      const order = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy]
      return rows.filter(row => matches(row, query.where)).sort((a, b) => {
        for (const rule of order) for (const [key, direction] of Object.entries(rule)) {
          const comparison = a[key] instanceof Date ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]))
          if (comparison) return direction === 'desc' ? -comparison : comparison
        }
        return 0
      }).slice(query.skip, query.skip + query.take)
    },
  } }
  const run = (query = {}, scope = {}) => withMocks({ [model]: { prisma: db } }, require.resolve(`../src/modules/${kind}/controller`), async controller => {
    const res = jsonResponse()
    await controller.list({ companyId: 'A', branchId: 'B', branchIds: ['B', 'C', 'D'], query, ...scope }, res, error => { throw error })
    return JSON.parse(JSON.stringify(res.body))
  })
  return { rows, calls, run, field, statuses, merchandise }
}
test('own receipts count as entries, never as unpaid purchases in summary or payment filters',async()=>{
  const f=documentFixture('merchandise');f.rows[0].source='PRODUCTION';f.rows[0].supplier=null;f.rows[1].source='INITIAL';f.rows[1].supplier=null;f.rows[2].source='PRODUCTION';f.rows[2].supplier=null
  const result=await f.run({includeSummary:'true'})
  assert.deepEqual(result.summary,{total:9,paid:2,partial:2,pending:2})
  const pending=await f.run({payment_status:'PENDING'});assert.equal(pending.totalItems,2)
})

for (const kind of ['merchandise', 'transfers']) {
  test(`${kind}: grouped summary counts the complete scope once and stable paging retains full document lines`, async () => {
    const f = documentFixture(kind), result = await f.run({ includeSummary: 'true', page: '999', pageSize: '2' })
    assert.deepEqual(result.summary, f.merchandise ? { total: 9, paid: 3, partial: 3, pending: 3 } : { total: 9, inTransit: 3, received: 3, cancelled: 3 })
    assert.deepEqual(f.calls.map(call => call.method), ['groupBy', 'page'])
    assert.deepEqual(f.calls[0].where, f.calls[1].where)
    assert.deepEqual(f.calls[1].orderBy, [{ [f.merchandise ? 'date' : 'sent_at']: 'desc' }, { id: 'desc' }])
    assert.equal(result.page, 5); assert.equal(result.totalPages, 5); assert.equal(result.nextPage, null); assert.equal(result.prevPage, 4)
    assert.equal(result.items[0].id, '00')
    if (f.merchandise) {
      assert.equal(result.items[0].totalValue, '240.00'); assert.equal(result.items[0].itemsCount, 1)
      assert.equal(result.items[0].items[0].unit_cost, '120.000001'); assert.equal(result.items[0].items[0].base_qty, '48'); assert.equal(result.items[0].items[0].line_total, '240.00')
      const legacy = await f.run({ page: '1', pageSize: '2' }); assert.equal(legacy.items[0].totalValue, 30); assert.equal(legacy.items[0].items[0].subtotal, 30)
      assert.ok(f.calls[1].include.items.include.product.select.barcode)
    } else {
      assert.deepEqual(result.items[0].lines, [{ id: 'LINE', product_id: 'P', product: { id: 'P', name: 'Cafe', barcode: '001', image_url: '/cafe.png' }, qty_sent: '1.125', qty_received: '0.125' }])
      assert.ok(f.calls[1].include.lines.include.product.select.image_url)
    }
  })
  test(`${kind}: filtered, consolidated, empty and no-summary callers preserve their contracts`, async () => {
    const f = documentFixture(kind)
    const query = f.merchandise ? { payment_status: 'PAID', supplier_id: 'S', search: 'Cafe', start_date: '2026-10-01', end_date: '2026-10-02' } : { status: 'EN_TRANSITO', direction: 'out', from_branch_id: 'B', to_branch_id: 'D', search: 'Cafe' }
    let result = await f.run({ ...query, includeSummary: 'true' })
    assert.equal(result.totalItems, 3); assert.equal(result.summary.total, 3); assert.equal(result.items.length, 3)
    assert.deepEqual(f.calls.map(call => call.method), ['groupBy', 'page']); assert.deepEqual(f.calls[0].where, f.calls[1].where)
    if (f.merchandise) { assert.equal(f.calls[0].where.branch_id, 'B'); assert.equal(f.calls[0].where.supplier_id, 'S'); assert.equal(f.calls[0].where.date.gte.toISOString(), '2026-10-01T00:00:00.000Z') }
    else { assert.ok(f.calls[0].where.AND.some(part => part.fromBranch?.company_id === 'A')); assert.ok(f.calls[0].where.AND.some(part => part.from_branch_id === 'B')) }
    f.calls.length = 0; result = await f.run({ pageSize: '2' }); assert.equal(result.summary, undefined); assert.equal(result.totalItems, 9); assert.deepEqual(f.calls.map(call => call.method), ['count', 'page'])
    f.calls.length = 0; result = await f.run({ includeSummary: 'true' }, { branchId: null }); assert.equal(result.totalItems, 10); assert.equal(result.items.some(row => row.id === 'FOREIGN'), false)
    f.calls.length = 0; result = await f.run({ includeSummary: 'true', search: 'Missing', page: '99' }); assert.equal(result.totalItems, 0); assert.equal(result.page, 1); assert.equal(result.totalPages, 1); assert.deepEqual(result.items, []); assert.ok(Object.values(result.summary).every(count => count === 0))
    f.rows.length = 0; result = await f.run({ includeSummary: 'true' }, { branchId: null, branchIds: [] }); assert.equal(result.totalItems, 0); assert.deepEqual(result.items, [])
  })
}
