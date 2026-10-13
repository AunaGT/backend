const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const controllerPath = require.resolve('../src/modules/reports/controller')
const brandingMock = { getBrandingForPdf: async () => ({ company_name: 'QA', currency_code: 'GTQ', timezone: 'America/Guatemala', logoBuffer: null }) }
const branchId = '11111111-1111-4111-8111-111111111111'
const companyId = '22222222-2222-4222-8222-222222222222'
const sessionId = '33333333-3333-4333-8333-333333333333'
const req = { companyId, branchId, query: { format: 'json', period: 'month', year: '2026', month: '10' } }
async function run(prisma, action, request = req) {
  return withMocks({ [require.resolve('../src/models/prisma')]: { prisma }, [require.resolve('../src/utils/pdfBranding')]: brandingMock }, controllerPath, async controller => {
    const res = jsonResponse()
    await controller[action](request, res, error => { throw error })
    return res.body
  })
}
test('count history values counted lines only and preserves session 81', async () => {
  const prisma = {
    branch: { findMany: async () => [{ id: branchId, name: 'Centro' }] },
    inventoryCountSession: { findMany: async ({ where }) => {
      assert.equal(where.branch_id, branchId); assert.equal(where.branch.company_id, companyId)
      assert.deepEqual(where.created_at, { gte: new Date('2026-10-01T06:00:00Z'), lt: new Date('2026-11-01T06:00:00Z') })
      return Array.from({ length: 81 }, (_, i) => ({ id: i === 0 ? sessionId : `s${i}`, name: `Conteo ${i}`, status: 'APPROVED', created_at: new Date('2026-10-01T12:00:00Z'), approved_at: null, approvedBy: null, createdBy: { name: 'QA' }, _count: { lines: 2 } }))
    } }, inventoryCountLine: { groupBy: async ({ where }) => { assert.deepEqual(where.qty_counted, { not: null }); return [{ session_id: sessionId, _count: { id: 1 } }] },
      findMany: async ({ where }) => { assert.equal(where.session_id.in.length, 81); assert.deepEqual(where.qty_counted, { not: null });
        return [{ session_id: sessionId, stock_snapshot: 10, qty_counted: 8, product: { cost: 3 } }] } },
  }
  const report = await run(prisma, 'inventoryCountsHistoryReport')
  const rows = report.sections.find(s => s.id === 'sessions').rows
  assert.equal(rows.length, 81); assert.equal(rows[0].counted, 1); assert.equal(rows[0].differenceValue, -6); assert.equal(rows[0].lossValue, 6)
})
test('alerts retain row 251 and use the branch minimum, not global minimum', async () => {
  const prisma = { branch: { findMany: async () => [{ id: branchId, name: 'Centro' }] },
    product: { findMany: async () => [{ id: 'p', name: 'QA', stock: 99, min_stock: 10, cost: 3 }] },
    productStock: { findMany: async () => [{ product_id: 'p', stock: 2, min_stock: 1 }] },
    alert: { count: async ({ where }) => { assert.equal(where.branch.company_id, companyId); return 251 }, findMany: async ({ take, where }) => {
      assert.ok(take > 251); assert.equal(where.branch_id, branchId)
      return Array.from({ length: 251 }, (_, i) => ({ id: `a${i}`, title: `Alerta ${i}`, timestamp: new Date('2026-10-01T12:00:00Z'), product: { name: 'QA' }, type: null, priority: null, status: null, assignedTo: null }))
    } } }
  const report = await run(prisma, 'alertsReport')
  assert.equal(report.summary.find(m => m.id === 'at-risk').value, 0)
  assert.equal(report.sections.find(s => s.id === 'system-alerts').rows.length, 251)
})
test('merchandise reports received cost, not paid amounts, with company-local dates', async () => {
  const prisma = { branch: { findMany: async () => [{ id: branchId, name: 'Centro' }] }, incomingMerchandise: { findMany: async ({ where }) => {
    assert.equal(where.branch_id, branchId); assert.equal(where.branch.company_id, companyId)
    return ['PAID', 'PARTIAL', 'PENDING'].map(payment_status => ({ date: new Date('2026-10-02T02:00:00Z'), payment_status, branch: { name: 'Centro' }, supplier: null, registeredBy: null, items: [{ quantity: 2, unit_cost: 3 }] }))
  } } }
  const report = await run(prisma, 'merchandiseReport')
  assert.equal(report.summary.find(m => m.id === 'received').value, 18)
  assert.equal(report.sections.find(s => s.id === 'detail').rows[0].date, '2026-10-01')
  assert.deepEqual(report.sections.find(s => s.id === 'detail').rows.map(r => r.status), ['Pagado', 'Pago parcial', 'Pendiente'])
})
