const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { buildInventoryReport, buildSuppliersReport, buildProductsReport } = require('../src/modules/reports/models/catalog')
const meta = { generatedAt: '2026-10-09T12:00:00Z', timezone: 'America/Guatemala', currency: 'GTQ', generatedBy: null,
  scope: { companyId: 'qa', label: 'Consolidado', branches: [], warehouse: null, location: null },
  period: { mode: 'current', start: null, endExclusive: null, label: 'Actual' }, branding: { companyName: 'QA', logoDataUrl: null } }
test('inventory keeps product 101 and its server valuation with current temporal semantics', () => {
  const products = Array.from({ length: 101 }, (_, i) => ({ id: String(i), name: `Artículo ${i}`, stock: 2, cost: 3, category: null }))
  const report = buildInventoryReport({ products, byBranch: [], byWarehouse: [] }, meta)
  assert.equal(report.sections.find(s => s.id === 'detail').rows.length, 101)
  assert.equal(report.period.mode, 'current')
  assert.equal(report.summary.find(m => m.id === 'value').value, 606)
})
test('supplier detail is not silently cut to 300 and excludes private storage fields', () => {
  const suppliers = Array.from({ length: 301 }, (_, i) => ({ id: String(i), name: `Proveedor ${i}`, productCount: 0, stockUnits: 0,
    inventoryValue: 0, image_storage_path: 'private', phone: null, email: null, contact: null, paymentTermName: null }))
  const report = buildSuppliersReport({ suppliers, summary: { totalSuppliers: 301, activeSuppliers: 0, withoutProducts: 301, totalInventoryValue: 0 } }, meta)
  assert.equal(report.sections.find(s => s.id === 'detail').rows.length, 301)
  assert.doesNotMatch(JSON.stringify(report), /private|image_storage_path/)
})
test('product price margin null stays absent, zero stays zero and detail has all 91 rows', () => {
  const products = Array.from({ length: 91 }, (_, i) => ({ id: String(i), name: `P${i}`, units: 2, cost: 3, price: 0, marginPct: null, invValue: 6, retailValue: 0 }))
  const report = buildProductsReport({ products, summary: { totalSkus: 91, inventoryValue: 546, retailInventoryValue: 0, weightedMarginPct: 0, pricingFlags: 0 },
    categoryRows: [], supplierRows: [], topByInv: [], topByRetail: [], tightMargins: [] }, meta)
  const rows = report.sections.find(s => s.id === 'detail').rows
  assert.equal(rows.length, 91)
  assert.equal(rows[0].margin, null)
  assert.equal(rows[0].price, 0)
})
test('warehouse homonyms do not merge and the same product in two locations counts once per warehouse', async () => {
  const prisma = { branch: { findMany: async () => [{ id: 'b1', name: 'Centro' }, { id: 'b2', name: 'Norte' }] },
    product: { findMany: async () => [] }, productStock: { findMany: async () => [] },
    productStockLocation: { findMany: async () => [
      { product_id: 'p1', stock: 1, product: { cost: 3 }, location: { warehouse: { id: 'w1', name: 'Bodega', branch: { name: 'Centro' } } } },
      { product_id: 'p1', stock: 2, product: { cost: 3 }, location: { warehouse: { id: 'w1', name: 'Bodega', branch: { name: 'Centro' } } } },
      { product_id: 'p1', stock: 3, product: { cost: 3 }, location: { warehouse: { id: 'w2', name: 'Bodega', branch: { name: 'Norte' } } } },
    ] } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma },
    [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({}) },
  }, require.resolve('../src/modules/reports/controller'), async controller => {
    const res = jsonResponse()
    await controller.inventoryReport({ companyId: 'qa', branchIds: ['b1', 'b2'], query: { format: 'json' } }, res, e => { throw e })
    const rows = res.body.sections.find(s => s.id === 'by-warehouse').rows
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(r => r.skus), [1, 1])
    assert.notEqual(rows[0].warehouse, rows[1].warehouse)
    assert.deepEqual(rows.map(r => r.value), [9, 9])
  })
})
