const test = require('node:test')
const assert = require('node:assert/strict')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')
const { buildInternalMovesReport, buildKardexReport } = require('../src/modules/reports/models/stock')
const meta = { generatedAt: '2026-10-09T12:00:00Z', timezone: 'America/Guatemala', currency: 'GTQ', generatedBy: null,
  scope: { companyId: 'qa', label: 'Centro', branches: [], warehouse: null, location: { id: 'to', name: 'Destino' } },
  period: { mode: 'period', start: null, endExclusive: null, label: 'Todos' }, branding: { companyName: 'QA', logoDataUrl: null } }
const move = (id, group_id, productId, qty, locationId) => ({ id, group_id, created_at: new Date('2026-10-01T12:00:00Z'), product: { id: productId, name: 'Arroz' },
  product_id: productId, qty, balance: 12, reason: 'INTERNAL_MOVE', createdBy: null, location: { id: locationId, code: locationId, warehouse: { id: locationId === 'to' ? 'w2' : 'w1', name: locationId === 'to' ? 'Sala' : 'Bodega' } } })
test('internal report pairs by product ID, keeps both places and does not double units', () => {
  const report = buildInternalMovesReport({ movements: [move('1', 'g1', 'p1', -3, 'from'), move('2', 'g1', 'p1', 3, 'to'), move('3', 'g1', 'p2', -5, 'from'), move('4', 'g1', 'p2', 5, 'to')] }, meta)
  const rows = report.sections[0].rows
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.units), [3, 5])
  assert.match(rows[0].origin, /Bodega/); assert.match(rows[0].destination, /Sala/)
  assert.equal(report.summary.find(m => m.id === 'units').value, 8)
})
test('unpaired historic entries do not invent an origin or match unrelated null groups', () => {
  const report = buildInternalMovesReport({ movements: [move('1', null, 'p1', 3, 'to'), move('2', null, 'p1', -3, 'from')] }, meta)
  assert.equal(report.sections[0].rows.length, 2)
  assert.equal(report.sections[0].rows[0].origin, null)
  assert.match(report.notes.join(' '), /incomplet/)
})
test('kardex keeps row 5001 and never sums unrelated recorded balances', () => {
  const report = buildKardexReport({ movements: Array.from({ length: 5001 }, (_, i) => move(String(i), 'g', `p${i}`, 1, 'to')) }, meta)
  assert.equal(report.sections[0].rows.length, 5001)
  assert.ok(!report.sections[0].totals?.balance)
})
test('internal controller expands only matching authorized groups before building JSON', async () => {
  let reads = 0
  const req = { companyId: 'qa', branchId: 'b', query: { format: 'json', period: 'all', location_id: '11111111-1111-4111-8111-111111111111' }, reportLocations: { warehouse: null, location: { id: 'to', name: 'Sala' } } }
  const prisma = { branch: { findMany: async () => [{ id: 'b', name: 'Centro' }] }, stockMovement: { findMany: async ({ where, take }) => {
    assert.deepEqual(where.branch_id, { in: ['b'] }); assert.equal(where.branch.company_id, 'qa'); assert.ok(take > 5000)
    reads++
    if (reads === 1) { assert.equal(where.location_id, req.query.location_id); return [move('2', 'g1', 'p1', 3, 'to')] }
    assert.ok(!where.location_id)
    assert.deepEqual(where.OR, [{ group_id: 'g1', product_id: 'p1' }])
    return [move('1', 'g1', 'p1', -3, 'from'), move('2', 'g1', 'p1', 3, 'to')]
  } } }
  await withMocks({ [require.resolve('../src/models/prisma')]: { prisma }, [require.resolve('../src/utils/pdfBranding')]: { getBrandingForPdf: async () => ({}) } },
    require.resolve('../src/modules/reports/stock.controller'), async controller => {
      const res = jsonResponse()
      await controller.internalMovesReport(req, res, e => { throw e })
      assert.equal(reads, 2); assert.match(res.body.sections[0].rows[0].origin, /Bodega/)
    })
})
