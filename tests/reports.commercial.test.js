const test = require('node:test')
const assert = require('node:assert/strict')
test('sales snapshot preserves server cost, gross profit and total units', () => {
  const { buildSalesReport } = require('../src/modules/reports/models/commercial')
  const report = buildSalesReport({ totalRevenueGross: 100, totalReturned: 10, totalRevenue: 90, totalCost: 60, totalProfit: 30, unidadesTotales: 7, tickets: 2, ticketPromedio: 45, salesByBranch: [], topProducts: [], categories: [], salesByMethod: [], salesByPeriod: [], salesByCashier: [] }, {})
  assert.equal(report.summary.find(m => m.id === 'cost')?.value, 60)
  assert.equal(report.summary.find(m => m.id === 'profit')?.value, 30)
  assert.equal(report.summary.find(m => m.id === 'units')?.value, 7)
})
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { buildSalesReport, buildFinancialReport } = require('../src/modules/reports/models/commercial')
const meta = { generatedAt: '2026-10-09T12:00:00Z', timezone: 'America/Guatemala', currency: 'GTQ', generatedBy: null,
  scope: { companyId: 'qa', label: 'Centro', branches: [], warehouse: null, location: null },
  period: { mode: 'period', start: null, endExclusive: null, label: 'Todo el historial' }, branding: { companyName: 'QA', logoDataUrl: null } }
const data = { totalRevenueGross: 100, totalReturned: 25, totalRevenue: 75, totalCost: 40, totalProfit: 35,
  tickets: 1, unidadesTotales: 2, ticketPromedio: 75, salesByBranch: [], categories: [{ category: 'A', revenue: 100 }],
  topProducts: [], salesByMethod: [], salesByPeriod: [], salesByCashier: [], useDaily: true }
test('sales distinguishes gross and net and labels gross category breakdown', () => {
  const report = buildSalesReport(data, meta)
  assert.equal(report.summary.find(m => m.id === 'net').value, 75)
  assert.equal(report.summary.find(m => m.id === 'returns').value, 25)
  assert.equal(report.sections.find(s => s.id === 'by-method').rows.length, 0)
  assert.match(report.sections.find(s => s.id === 'by-category').title, /brut/i)
  assert.equal(report.sections.find(s => s.id === 'by-category').rows[0].revenue, 100)
})
test('financial omits company-only purchases in branch scope without implying zero', () => {
  const report = buildFinancialReport({ ...data, purchasesAttributable: false, purchasesPeriod: null, purchasesBySupplier: [],
    inventoryValue: 30, inventoryValueOwned: 35, inTransitValue: 5, inventoryUnits: 4, inventorySkuCount: 2,
    categoryProfitability: [], grossMarginPct: 46.7, daysOfInventoryApprox: null, byBranch: [], byWarehouse: [] }, meta)
  assert.ok(!report.sections.some(s => s.id === 'purchases-by-supplier'))
  assert.ok(!report.summary.some(m => m.id === 'purchases'))
  assert.match(report.notes.join(' '), /sucursal/)
})
test('branch financial calculation never queries company-only PurchaseLog; unbounded period has no duration', async () => {
  let purchasesRead = 0
  const prisma = { saleStatus: { findFirst: async () => ({ id: 1 }) },
    sale: { findMany: async ({ where }) => { assert.deepEqual(where.date, {}); return [] } },
    saleItem: { findMany: async ({ where }) => {
      assert.deepEqual((where.sale.AND?where.sale.AND[1]:where.sale).date,{})
      assert.deepEqual(where.sale.AND?where.sale.AND[0].status:where.sale.status,{name:'Completada'})
      return []
    } },
    product: { findMany: async () => [] }, purchaseLog: { findMany: async () => { purchasesRead++; return [] } } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma },
    [require.resolve('../src/services/inTransit')]: { inTransitTotals: async () => ({ units: 0, value: 0 }) },
  }, require.resolve('../src/modules/reports/controller'), async controller => {
    const result = await controller.getFinancialData(null, null, { companyId: 'qa', branchId: 'branch',
      reportPeriod: { start: null, endExclusive: null }, query: {} })
    assert.equal(purchasesRead, 0)
    assert.equal(result.purchasesPeriod, null)
    assert.equal(result.daysOfInventoryApprox, null)
  })
})
test('sales JSON normalizes all-history before querying and preserves an adjusted total of zero', async () => {
  const prisma = { branch: { findMany: async () => [{ id: 'b', name: 'Centro' }] }, saleStatus: { findFirst: async () => ({ id: 1 }) },
    saleItem: { findMany: async ({ where }) => { assert.deepEqual(where.sale.AND[1].date, {});assert.deepEqual(where.sale.AND[0],{status:{name:'Completada'}}); return [] } },
    sale: { findMany: async ({ where }) => {
      assert.deepEqual(where.date, {})
      assert.equal(where.branch_id, 'b')
      return [{ id: 's', branch_id: 'b', date: new Date('2024-01-01T12:00:00Z'), total: 100, total_returned: 100, adjusted_total: 0, payment_method: null, createdBy: null }]
    } } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma },
    [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({ timezone: 'America/Guatemala' }) },
  }, require.resolve('../src/modules/reports/controller'), async controller => {
    const res = jsonResponse()
    await controller.salesReport({ companyId: 'qa', branchId: 'b', query: { format: 'json', period: 'all' } }, res, e => { throw e })
    assert.equal(res.body.summary.find(m => m.id === 'net').value, 0)
    assert.equal(res.body.sections.find(s => s.id === 'by-method').rows[0].revenue, 0)
  })
})
test('legacy branch CSV omits purchases and explicitly explains missing branch attribution', async () => {
  const prisma = { branch: { findMany: async () => [{ id: 'b', name: 'Centro' }] },
    saleStatus: { findFirst: async () => ({ id: 1 }) }, sale: { findMany: async () => [] }, saleItem: { findMany: async () => [] },
    product: { findMany: async () => [] }, productStockLocation: { findMany: async () => [] },
    purchaseLog: { findMany: async () => { throw new Error('Company purchases must not be read') } } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma },
    [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({ currency_code: 'GTQ' }) },
    [require.resolve('../src/services/inTransit')]: { inTransitTotals: async () => ({ units: 0, value: 0 }) },
  }, require.resolve('../src/modules/reports/controller'), async controller => {
    let csv
    const res = { setHeader() {}, send(value) { csv = value } }
    await controller.financialReport({ companyId: 'qa', branchId: 'b', query: { format: 'csv' } }, res, e => { throw e })
    assert.match(csv, /No disponibles: el registro histórico no identifica sucursal/)
    assert.doesNotMatch(csv, /Compras por proveedor|Compras registradas período/)
  })
})
test('consolidated finance separates opening stock from purchases and includes in-transit property', async () => {
  const prisma = { branch: { findMany: async () => [] }, saleStatus: { findFirst: async () => ({ id: 1 }) },
    sale: { findMany: async () => [] }, saleItem: { findMany: async () => [] },
    product: { findMany: async () => [{ id: 'p', stock: 99, cost: 3 }] }, productStock: { findMany: async () => [{ product_id: 'p', stock: 2 }] },
    purchaseLog: { findMany: async () => [{ source: 'INITIAL', qty: 10, cost: 3, supplier: null }, { source: 'PURCHASE', qty: 5, cost: 4, supplier: { name: 'QA' } }] } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma },
    [require.resolve('../src/services/inTransit')]: { inTransitTotals: async () => ({ units: 1, value: 3 }) },
  }, require.resolve('../src/modules/reports/controller'), async controller => {
    const data = await controller.getFinancialData(new Date('2026-10-01'), new Date('2026-11-01'), { companyId: 'qa', branchIds: ['b'], query: {} })
    assert.equal(data.inventoryValueOwned, 9)
    assert.equal(data.purchasesPeriod, 20)
    assert.equal(data.initialInventoryPeriod, 30)
    assert.equal(data.purchaseLogLines, 1)
  })
})
