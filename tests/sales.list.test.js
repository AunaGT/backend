const test = require('node:test')
const assert = require('node:assert/strict')
const { Settings } = require('luxon')

const prismaPath = require.resolve('../src/models/prisma')
const controllerPath = require.resolve('../src/modules/sales/controller')
const previous = require.cache[prismaPath]
const methods = [
  { id: 1, name: 'Efectivo', is_credit: false },
  { id: 2, name: 'Crédito 30 días', is_credit: true },
]
let records = []
let calls = []

// Only database I/O is replaced; the real controller, search and tenant logic run.
function matches(record, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return value.every(clause => matches(record, clause))
    if (key === 'OR') return value.some(clause => matches(record, clause))
    if (key === 'status' || key === 'payment_method') return matches(record[key], value)
    if (value && typeof value === 'object') {
      if (value.in) return value.in.includes(record[key])
      if (value.gte) return record[key] >= value.gte && record[key] <= value.lte
      const actual = String(record[key] ?? '').toLowerCase()
      if (value.equals !== undefined) return actual === value.equals.toLowerCase()
      if (value.contains !== undefined) return actual.includes(value.contains.toLowerCase())
      if (value.startsWith !== undefined) return actual.startsWith(value.startsWith.toLowerCase())
    }
    return record[key] === value
  })
}

function filtered(args, operation) {
  calls.push([operation, args])
  return records.filter(record => matches(record, args.where))
}

const prisma = {
  sale: {
    count: async args => filtered(args, 'count').length,
    findMany: async args => filtered(args, 'findMany')
      .sort((a, b) => b.date - a.date)
      .slice(args.skip || 0, (args.skip || 0) + args.take)
      .map(record => ({
        ...record,
        createdBy: args.include?.createdBy ? { id: 'seller-1', name: 'Ana', email: 'ana@example.com' } : undefined,
        payment_method: Object.fromEntries(Object.keys(args.include.payment_method.select).map(key => [key, record.payment_method[key]])),
      })),
    aggregate: async args => {
      const rows = filtered(args, 'aggregate')
      assert.deepEqual(args._sum, { adjusted_total: true })
      return { _sum: { adjusted_total: rows.length ? rows.reduce((sum, row) => sum + Number(row.adjusted_total), 0) : null }, _count: { _all: rows.length } }
    },
    groupBy: async args => {
      assert.deepEqual(args.by, ['payment_method_id'])
      const groups = new Map()
      for (const row of filtered(args, 'groupBy')) groups.set(row.payment_method_id, (groups.get(row.payment_method_id) || 0) + 1)
      return [...groups].map(([payment_method_id, count]) => ({ payment_method_id, _count: { _all: count } })).reverse()
    },
    findFirst: async args => filtered(args, 'findFirst').sort((a, b) => b.date - a.date)[0] || null,
  },
  paymentMethod: { findMany: async args => methods.filter(method => args.where.id.in.includes(method.id)) },
  supplier: { findFirst: async () => ({ id: 'customer-1', name: 'Ana', tax_id: '12345' }) },
  systemSetting: { findMany: async () => [] },
}
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma, prismaTransaction: prisma } }
const controller = require(controllerPath)
if (previous) require.cache[prismaPath] = previous
else delete require.cache[prismaPath]

function sale(id, overrides = {}) {
  const payment_method_id = overrides.payment_method_id || 1
  return {
    id, branch_id: 'branch-a', status: { id: 1, name: 'Completada' },
    date: new Date('2026-10-06T12:00:00Z'), customer: 'Ana', customer_nit: '12345',
    customer_contact_id: 'customer-1', total: '100.00', adjusted_total: '10.00',
    payment_method_id, payment_method: methods.find(method => method.id === payment_method_id),
    ...overrides,
  }
}

async function list(query, scope = {}) {
  calls = []
  let response
  const previousNow = Settings.now
  Settings.now = () => Date.parse('2026-10-06T18:00:00Z')
  try {
    await controller.list({
      query, companyId: 'company-a', branchId: 'branch-a', user: { permissions: ['sales.view', 'contacts.clients.view'] }, ...scope,
    }, { json: data => { response = data }, status() { return this } }, error => { throw error })
    return response
  } finally {
    Settings.now = previousNow
  }
}

test('payment name filters every sale before count and pagination, case-insensitively', async () => {
  records = [sale('cash-new'), sale('credit-new', { payment_method_id: 2 }), sale('cash-old'), sale('credit-old', { payment_method_id: 2 }), sale('other-branch', { branch_id: 'branch-b' })]
  const response = await list({ payment: ' eFeCtIvO ', page: '2', pageSize: '1' })
  assert.equal(response.totalItems, 2)
  assert.equal(response.totalPages, 2)
  assert.deepEqual(response.items.map(row => row.id), ['cash-old'])
  assert.deepEqual(calls.find(([operation]) => operation === 'count')[1].where.payment_method, { name: { equals: 'eFeCtIvO', mode: 'insensitive' } })
  assert.equal('summary' in response, false)
})

test('omitting status paginates completed and cancelled sales together in global date order', async () => {
  records = [sale('older', { date: new Date('2026-10-06T10:00:00Z') }), sale('cancelled', { date: new Date('2026-10-06T11:00:00Z'), status: { id: 2, name: 'Cancelada' } }), sale('newest')]
  const response = await list({ page: '2', pageSize: '1' })
  assert.equal(response.totalItems, 3)
  assert.equal(response.totalPages, 3)
  assert.equal(response.nextPage, 3)
  assert.equal(response.prevPage, 1)
  assert.deepEqual(response.items.map(row => row.id), ['cancelled'])
})

test('list rows expose a small seller projection and the payment credit flag', async () => {
  records = [sale('credit', { payment_method_id: 2 })]
  const response = await list({})
  assert.deepEqual(response.items[0].createdBy, { id: 'seller-1', name: 'Ana', email: 'ana@example.com' })
  assert.equal(response.items[0].payment_method.is_credit, true)
  assert.deepEqual(calls.find(([operation]) => operation === 'findMany')[1].include.createdBy, { select: { id: true, name: true, email: true } })
})

test('summary covers more than 500 matching sales, uses net totals including zero and excludes other scopes', async () => {
  records = Array.from({ length: 501 }, (_, index) => sale(`sale-${index}`, { payment_method_id: index < 200 ? 1 : 2 }))
  records.push(
    sale('full-return', { adjusted_total: '0.00', date: new Date('2026-10-06T13:00:00Z') }),
    sale('cancelled', { status: { id: 2, name: 'Cancelada' } }),
    sale('other-branch', { branch_id: 'branch-b' }),
    sale('last-month', { date: new Date('2026-09-30T12:00:00Z') }),
  )
  const response = await list({ status: 'Completada', period: 'month', includeSummary: 'true', pageSize: '1' })
  assert.equal(response.items.length, 1)
  assert.equal(response.items[0].adjusted_total, '0.00')
  assert.deepEqual(response.summary, { totalSales: 5010, transactionCount: 502, averageTicket: 5010 / 502, preferredPaymentMethod: 'Crédito 30 días' })
  const aggregate = calls.find(([operation]) => operation === 'aggregate')[1]
  const count = calls.find(([operation]) => operation === 'count')[1]
  assert.deepEqual(aggregate.where, count.where)
  assert.equal(aggregate.take, undefined)
  assert.equal(aggregate.skip, undefined)
  assert.deepEqual(calls.find(([operation]) => operation === 'groupBy')[1].where, count.where)
})

test('summary respects payment and consolidated scope, returns zero for empty sets and settles payment ties', async () => {
  records = [sale('cash'), sale('credit', { payment_method_id: 2 }), sale('other-branch', { branch_id: 'branch-b' })]
  const filteredResponse = await list({ payment: 'Efectivo', includeSummary: 'true' }, { branchId: null, branchIds: ['branch-a', 'branch-b'] })
  assert.deepEqual(filteredResponse.summary, { totalSales: 20, transactionCount: 2, averageTicket: 10, preferredPaymentMethod: 'Efectivo' })
  const tie = await list({ includeSummary: 'true' })
  assert.equal(tie.summary.preferredPaymentMethod, 'Crédito 30 días')
  records = []
  const empty = await list({ includeSummary: 'true' })
  assert.deepEqual(empty.summary, { totalSales: 0, transactionCount: 0, averageTicket: 0, preferredPaymentMethod: '—' })
})

test('global search retains count-free extra-row pagination and payment filtering', async () => {
  records = [sale('cash-1'), sale('credit', { payment_method_id: 2 }), sale('cash-2')]
  const response = await list({ search: 'Ana', period: 'year', payment: 'Efectivo', pageSize: '1' })
  assert.deepEqual(response.items.map(row => row.id), ['cash-1'])
  assert.equal(response.totalItems, null)
  assert.equal(response.totalPages, null)
  assert.equal(response.hasMore, true)
  assert.equal(response.nextPage, 2)
  assert.equal(calls.some(([operation]) => operation === 'count'), false)
  assert.equal(calls.some(([operation]) => operation === 'aggregate'), false)
  assert.equal(calls[0][1].where.date, undefined)
  const next = await list({ search: 'Ana', payment: 'Efectivo', pageSize: '1', page: '2' })
  assert.deepEqual(next.items.map(row => row.id), ['cash-2'])
  assert.equal(next.nextPage, null)
})

test('customer purchase summary remains completed-only alongside the optional list summary', async () => {
  records = [sale('completed'), sale('cancelled', { status: { id: 2, name: 'Cancelada' }, adjusted_total: '20.00' })]
  const response = await list({ customer_contact_id: 'customer-1', includeSummary: 'true' })
  assert.deepEqual(response.customerPurchaseSummary, { totalPurchases: 10, lastSaleDate: '2026-10-06T12:00:00.000Z' })
  assert.equal(response.summary.totalSales, 30)
  assert.equal(response.summary.transactionCount, 2)
})

test('short search returns an empty optional summary without querying sales', async () => {
  const response = await list({ search: 'An', includeSummary: 'true' })
  assert.deepEqual(response.summary, { totalSales: 0, transactionCount: 0, averageTicket: 0, preferredPaymentMethod: '—' })
  assert.equal(response.searchMeta.tooShort, true)
  assert.equal(calls.length, 0)
})
