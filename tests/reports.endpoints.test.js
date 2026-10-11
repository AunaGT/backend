const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const handlers = { sales: 'salesReport', inventory: 'inventoryReport', financial: 'financialReport', suppliers: 'suppliersReport',
  products: 'productsReport', alerts: 'alertsReport', merchandise: 'merchandiseReport', 'inventory-counts': 'inventoryCountsHistoryReport',
  'stock-by-location': 'stockByLocationReport', kardex: 'kardexReport', 'internal-moves': 'internalMovesReport', replenishment: 'replenishmentReport', occupancy: 'occupancyReport' }
const companyId = '11111111-1111-4111-8111-111111111111'
const branchId = '22222222-2222-4222-8222-222222222222'
for (const empty of [true, false]) for (const [id, handler] of Object.entries(handlers)) {
  test(`${id} JSON ${empty ? 'empty' : 'normal'} uses typed data and an authorized scope`, async () => {
    const item = { id: 'p', name: 'Producto QA', stock: 2, min_stock: 3, cost: 3, price: 5, category: { name: 'QA' }, supplier: { name: 'Proveedor QA' }, supplier_id: 'supplier' }
    const rows = value => empty ? [] : [value]
    const prisma = {
      branch: { findMany: async () => [{ id: branchId, name: 'Centro' }] }, saleStatus: { findFirst: async () => ({ id: 1 }) },
      product: { findMany: async () => rows(item) },
      productStock: { findMany: async () => rows({ product_id: 'p', branch_id: branchId, stock: 2, min_stock: 3, product: { cost: 3 } }) },
      productStockLocation: { findMany: async () => rows({ product_id: 'p', stock: 2, product: { cost: 3 }, location: { code: 'GENERAL', warehouse: { id: 'w', name: 'Bodega', branch: { name: 'Centro' } } } }) },
      supplier: { findMany: async () => rows({ id: 'supplier', name: 'Proveedor QA', estado: 1, supplier_payment_terms: [] }) },
      sale: { findMany: async () => rows({ id: 's', branch_id: branchId, date: new Date('2026-10-01T12:00:00Z'), total: 10, total_returned: 0, adjusted_total: 10, payment_method: null, createdBy: null }) },
      saleItem: { findMany: async () => rows({ qty: 2, price: 5, product: item, sale: { id: 's' } }) },
      alert: { count: async () => empty ? 0 : 1, findMany: async () => rows({ title: 'Alerta QA', timestamp: new Date('2026-10-01T12:00:00Z'), product: item }) },
      incomingMerchandise: { findMany: async () => rows({ date: new Date('2026-10-01T12:00:00Z'), items: [{ quantity: 2, unit_cost: 3 }], payment_status: 'PENDING' }) },
      inventoryCountSession: { findMany: async () => rows({ id: 'session', status: 'DRAFT', created_at: new Date('2026-10-01T12:00:00Z'), _count: { lines: 0 } }) },
      inventoryCountLine: { groupBy: async ({where}) => {assert.deepEqual(where.product.kind,{not:'SERVICE'});return[]}, findMany: async ({where}) => {assert.deepEqual(where.product.kind,{not:'SERVICE'});return[]} },
      stockMovement: { findMany: async () => rows({ id: 'move', group_id: null, product_id: 'p', product: item, created_at: new Date('2026-10-01T12:00:00Z'), qty: 2, balance: 2, reason: 'PURCHASE', location: { id: 'l', code: 'GENERAL', warehouse: { id: 'w', name: 'Bodega' } } }) },
      $queryRaw: async () => rows({ warehouse_id: 'w', warehouse: 'Bodega · Centro', location: 'GENERAL', skus: 1, units: 2, value: 6, pickable: true }),
    }
    const stock = ['stock-by-location', 'kardex', 'internal-moves', 'replenishment', 'occupancy'].includes(id)
    await withMocks({ [require.resolve('../src/models/prisma')]: { prisma },
      [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({ company_name: 'QA', currency_code: 'GTQ', timezone: 'America/Guatemala' }) },
      [require.resolve('../src/services/inTransit')]: { inTransitTotals: async () => ({ units: 0, value: 0 }) },
      [require.resolve('../src/services/stockLocations')]: { replenishmentSuggestions: async () => rows({ product_name: 'QA', warehouse_name: 'Bodega', location_code: 'GENERAL', location_id: 'l', stock: 2, min_stock: 3, missing: 1, suggested_qty: 0 }) },
    }, require.resolve(`../src/modules/reports/${stock ? 'stock.controller' : 'controller'}`), async controller => {
      const res = jsonResponse()
      await controller[handler]({ companyId, branchId, query: { format: 'json', period: 'month', year: '2026', month: '10' } }, res, e => { throw e })
      const report = res.body
      assert.equal(report.id, id)
      assert.equal(report.scope.companyId, companyId)
      assert.equal(report.scope.branches[0].id, branchId)
      assert.equal(report.currency, 'GTQ')
      assert.ok(report.sections.length)
      for (const section of report.sections) for (const row of section.rows) for (const column of section.columns) {
        const value = row[column.id]
        assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value))
        if (value !== null && ['money', 'decimal', 'integer', 'percent'].includes(column.type)) {
          if(column.quantityDecimals!=null)assert.ok(Number.isFinite(Number(value)),`${id}.${column.id}`)
          else assert.equal(typeof value, 'number', `${id}.${column.id}`)
        }
      }
      assert.doesNotMatch(JSON.stringify(report), /image_storage_path|password|DATABASE_URL/)
    })
  })
}
