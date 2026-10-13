const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const companyId = '11111111-1111-4111-8111-111111111111'
const branchId = '22222222-2222-4222-8222-222222222222'
const otherId = '33333333-3333-4333-8333-333333333333'
const target = require.resolve('../src/modules/reports/controller')
test('single count cannot read lines from a branch the user cannot access', async () => {
  let linesRead = false
  const prisma = { inventoryCountSession: { findFirst: async ({ where }) => {
    assert.equal(where.branch_id, branchId)
    assert.equal(where.branch.company_id, companyId)
    return null
  } }, inventoryCountLine: { findMany: async () => { linesRead = true; return [] } } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma } }, target, async controller => {
    const res = jsonResponse()
    await controller.inventoryCountSessionReport({ companyId, branchId, params: { id: otherId }, query: { format: 'csv' } }, res, e => { throw e })
    assert.equal(res.statusCode, 404)
    assert.equal(linesRead, false)
  })
})
test('history isolates company and branches before retrieving counted lines', async () => {
  const stop = new Error('scope checked')
  await withMocks({
    [require.resolve('../src/models/prisma')]: { prisma: { inventoryCountSession: { findMany: async ({ where }) => {
      assert.deepEqual(where.branch_id, { in: [branchId] })
      assert.equal(where.branch.company_id, companyId)
      throw stop
    } } } },
    [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({}) },
  }, target, async controller => {
    let caught
    await controller.inventoryCountsHistoryReport({ companyId, branchIds: [branchId], query: { format: 'csv' } }, jsonResponse(), e => { caught = e })
    assert.equal(caught, stop)
  })
})
test('warehouse, location and product must belong to the selected authorized scope', async () => {
  const { validateReportScope } = require('../src/modules/reports/reportFilters')
  const req = { companyId, branchId, query: { warehouse_id: otherId } }
  await assert.rejects(validateReportScope({ warehouse: { findFirst: async ({ where }) => {
    assert.equal(where.branch.company_id, companyId)
    assert.deepEqual(where.branch_id, { in: [branchId] })
    return null
  } } }, req), e => e.status === 404)
  await assert.rejects(validateReportScope({}, { ...req, query: { warehouse_id: 'not-uuid' } }), e => e.status === 400)
  await assert.rejects(validateReportScope({ product: { findFirst: async ({ where }) => {
    assert.equal(where.company_id, companyId); return null
  } } }, { ...req, query: { product_id: otherId } }), e => e.status === 404)
  await assert.rejects(validateReportScope({ stockLocation: { findFirst: async ({ where }) => {
    assert.equal(where.warehouse.branch.company_id, companyId)
    assert.deepEqual(where.warehouse.branch_id, { in: [branchId] })
    return null
  } } }, { ...req, query: { location_id: otherId } }), e => e.status === 404)
})
test('system alert count and rows use the identical authorized tenant condition', async () => {
  const stop = new Error('alert scope checked')
  let countWhere
  await withMocks({
    [require.resolve('../src/models/prisma')]: { prisma: {
      branch: { findMany: async () => [] }, product: { findMany: async () => [] },
      alert: { count: async ({ where }) => { countWhere = where; return 1 }, findMany: async ({ where }) => {
        assert.deepEqual(where, { resolved: 0, branch_id: branchId, branch: { company_id: companyId } })
        assert.deepEqual(countWhere, where); throw stop
      } },
    } },
    [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({}) },
  }, target, async controller => {
    let caught
    await controller.alertsReport({ companyId, branchId, query: { format: 'csv' } }, jsonResponse(), e => { caught = e })
    assert.equal(caught, stop)
  })
})
test('every report endpoint requires its owning modules after authentication', async () => {
  const owners = { sales: ['sales'], inventory: ['inventory'], suppliers: ['contacts'], financial: ['sales', 'inventory'],
    alerts: ['alerts'], products: ['inventory'], 'stock-by-location': ['inventory'], kardex: ['inventory'],
    'internal-moves': ['inventory'], replenishment: ['inventory'], occupancy: ['inventory'], merchandise: ['merchandise'],
    'inventory-count-session/:id': ['inventory-count'], 'inventory-counts': ['inventory-count'] }
  const auth = (req, res, next) => next()
  await withMocks({
    [require.resolve('../src/middlewares/autenticacion')]: { Auth: auth, hasPermission: () => (req, res, next) => next() },
    [require.resolve('../src/models/prisma')]: { prisma: {} },
    [require.resolve('../src/modules/platform/middleware')]: { requireModule: code => Object.assign((req, res, next) => next(), { owner: code }) },
    [require.resolve('../src/modules/reports/controller')]: new Proxy({}, { get: () => (req, res) => res.json({}) }),
    [require.resolve('../src/modules/reports/stock.controller')]: new Proxy({}, { get: () => (req, res) => res.json({}) }),
  }, require.resolve('../src/modules/reports/routes'), async router => {
    for (const [path, modules] of Object.entries(owners)) {
      const route = router.stack.find(layer => layer.route?.path === `/${path}`).route
      assert.equal(route.stack[0].handle, auth)
      assert.deepEqual(route.stack.map(layer => layer.handle.owner).filter(Boolean), modules, path)
    }
  })
})
