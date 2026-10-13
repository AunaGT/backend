const test = require('node:test')
const assert = require('node:assert/strict')
require('./setup-env')

function load(t, path, prisma) {
  const model = require.resolve('../src/models/prisma')
  const controller = require.resolve(path)
  const previous = require.cache[model]
  require.cache[model] = { exports: { prisma, prismaTransaction: prisma } }
  delete require.cache[controller]
  t.after(() => { delete require.cache[controller]; if (previous) require.cache[model] = previous; else delete require.cache[model] })
  return require(controller)
}

for (const [path, model, query, field, groups] of [
  ['../src/modules/inventory-count/controller', 'inventoryCountSession', { q: 'ana', status: 'DRAFT', limit: '1', offset: '2' }, 'status', [{ status: 'DRAFT', _count: { _all: 9 } }]],
  ['../src/modules/hr/controllers/advances', 'employeeAdvance', { employee_id: 'employee', status: 'PENDIENTE', page: '2', pageSize: '1' }, 'status', [{ status: 'PENDIENTE', _count: { _all: 9 } }]],
  ['../src/modules/contacts/controller', 'supplier', { search: 'ana', party_type: 'SUPPLIER', page: '2', pageSize: '1' }, 'estado', [{ estado: 1, _count: { _all: 9 } }]],
  ['../src/modules/cash-closure/controller', 'cashClosure', { status: 'Pendiente', startDate: '2026-10-01', endDate: '2026-10-07', page: '2', pageSize: '1' }, 'status', [{ status: 'Pendiente', _count: { _all: 9 } }]],
]) {
  test(`${model}: opt-in summary uses the complete list filters before pagination`, async t => {
    let listWhere, summaryWhere, response
    let grouped = 0
    const prisma = { [model]: {
      count: async () => 9,
      findMany: async ({ where }) => { listWhere = where; return [] },
      groupBy: async ({ where, by }) => { grouped++; summaryWhere = where; assert.deepEqual(by, [field]); return groups },
    }, systemSetting: { findMany: async () => [] } }
    const controller = load(t, path, prisma)
    const req = { companyId: 'company', branchId: 'branch', user: { permissions: ['contacts.suppliers.view'] }, query }
    await controller.list(req, { json: value => { response = value } }, e => { throw e })
    assert.equal(response.summary, undefined)
    assert.equal(grouped, 0)
    req.query = { ...query, includeSummary: 'true' }
    await controller.list(req, { json: value => { response = value } }, e => { throw e })
    assert.equal(response.summary?.total, 9)
    assert.deepEqual(summaryWhere, listWhere)
    assert.equal(grouped, 1)
    assert.equal(JSON.stringify(summaryWhere).includes('company') || summaryWhere.branch_id === 'branch', true)
  })
}

test('users: status counts retain effective company role and search scope, with no unrequested summary', async t => {
  const filters = []
  const controller = load(t, '../src/modules/users/adminController', { user: {
    count: async ({ where }) => { filters.push(where); return filters.length === 1 ? 12 : 4 }, findMany: async () => [],
  } })
  let response
  await controller.list({ companyId: 'company', query: { search: 'ventas', role_id: '2', pageSize: '1', includeSummary: 'true' } }, { json: value => { response = value } }, e => { throw e })
  assert.deepEqual(response.summary, { total: 12, ACTIVE: 4, INACTIVE: 4, BLOCKED: 4 })
  assert.equal(filters.length, 4)
  for (const where of filters.slice(1)) assert.deepEqual(where.AND[0], filters[0])
})

test('products: opt-in counts preserve catalog, category and company scope', async t => {
  const filters = []
  const controller = load(t, '../src/modules/inventory/products.controller', { product: {
    count: async ({ where }) => { filters.push(where); return filters.length === 1 ? 18 : 3 }, findMany: async () => [],
  } })
  let response
  await controller.list({ companyId: 'company', query: { branch_id: 'all', search: 'ana', category: 'bebidas', pageSize: '1', includeSummary: 'true' } }, { json: value => { response = value } }, e => { throw e })
  assert.deepEqual(response.summary, { total: 18, forSale: 3, kits: 3, tracksExpiry: 3 })
  for (const where of filters.slice(1)) assert.deepEqual(where.AND[0], filters[0])
})

test('deleted products: filter before paging and count the entire filtered archive', async t => {
  const counts = []
  let selection, response
  const controller = load(t, '../src/modules/inventory/products.controller', { product: {
    count: async ({ where }) => { counts.push(where); return counts.length === 1 ? 45 : 3 },
    findMany: async args => { selection = args; return [] },
  } })
  await controller.list({ companyId: 'company', query: { deletedOnly: 'true', includeDeleted: 'true', search: 'agua', category: 'Bebidas', page: '2', pageSize: '20', includeSummary: 'true' } }, { json: value => { response = value } }, e => { throw e })
  assert.equal(selection.where.deleted, true, 'Deleted-only takes precedence over includeDeleted')
  assert.equal(selection.where.company_id, 'company')
  assert.deepEqual(selection.where.category, { name: { equals: 'Bebidas', mode: 'insensitive' } })
  assert.deepEqual(selection.where.OR[0], { name: { contains: 'agua', mode: 'insensitive' } })
  assert.equal(selection.skip, 20)
  assert.equal(selection.take, 20)
  assert.equal(response.totalItems, 45)
  assert.equal(response.totalPages, 3)
  assert.equal(response.page, 2)
  assert.deepEqual(response.summary, { total: 45, forSale: 3, kits: 3, tracksExpiry: 3 })
  for (const where of counts.slice(1)) assert.deepEqual(where.AND[0], selection.where)
})

test('products: archive filtering leaves default and legacy catalog requests unchanged', async t => {
  let where, response
  const controller = load(t, '../src/modules/inventory/products.controller', { product: {
    count: async () => 0,
    findMany: async args => { where = args.where; assert.equal(args.skip, 0); return [] },
  } })
  for (const [query, deleted] of [[{}, false], [{ includeDeleted: 'true' }, undefined], [{ deletedOnly: 'true' }, true]]) {
    await controller.list({ companyId: 'company', query: { ...query, page: '4' } }, { json: value => { response = value } }, e => { throw e })
    assert.equal(where.deleted, deleted)
    assert.equal(response.page, 1, 'An empty last page after restoration clamps safely')
    assert.deepEqual(response.items, [])
  }
})

test('stock history: signed counts preserve branch and movement filters', async t => {
  const filters = []
  const controller = load(t, '../src/modules/inventory/stock.controller', { stockMovement: {
    count: async ({ where }) => { filters.push(where); return filters.length === 1 ? 18 : 3 }, findMany: async () => [],
  } })
  let response
  await controller.list({ companyId: 'company', branchId: 'branch', query: { location_id: 'location', search: 'ana', pageSize: '1', includeSummary: 'true' } }, { json: value => { response = value } }, e => { throw e })
  assert.deepEqual(response.summary, { total: 18, incoming: 3, outgoing: 3 })
  for (const where of filters.slice(1)) assert.deepEqual(where.AND[0], filters[0])
})

test('attendance: period-only summary returns no rows and retains employee/date scope', async t => {
  let summaryWhere
  const controller = load(t, '../src/modules/hr/controllers/attendance', { attendance: {
    findMany: async () => { assert.fail('summary-only requests must not fetch attendance rows') },
    groupBy: async ({ where }) => { summaryWhere = where; return [{ status: 'PRESENTE', _count: { _all: 26 } }, { status: 'TARDE', _count: { _all: 2 } }] },
  } })
  let response
  await controller.list({ companyId: 'company', branchId: 'branch', query: { from: '2026-10-01', to: '2026-10-07', employee_id: 'employee', includeSummary: 'true', summaryOnly: 'true' } }, { json: value => { response = value } }, e => { throw e })
  assert.equal(response.summary?.total, 28)
  assert.equal(response.summary?.PRESENTE, 26)
  assert.equal(response.summary?.AUSENTE, 0)
  assert.deepEqual(response.items, [])
  assert.equal(summaryWhere.company_id, 'company')
  assert.equal(summaryWhere.employee_id, 'employee')
  assert.equal(summaryWhere.work_date.gte.toISOString().slice(0, 10), '2026-10-01')
})
