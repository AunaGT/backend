const test = require('node:test'), assert = require('node:assert/strict')
const api = () => require('../src/services/payroll/deductions')
const D = { id: 'D', employee_id: 'E', company_id: 'A', branch_id: 'B', revision: 1, amount: '20.00', reason: 'Acuerdo', target_run_id: null, applied_run_id: null, status: 'PENDIENTE', created_at: new Date('2026-10-20T18:00:00Z') }
function fixture() {
  const rows = [{ ...D }], events = []
  const db = { $queryRaw: async () => [{ id: 'E' }], employeeDeduction: {
    findMany: async ({ where }) => rows.filter(r => r.status === where.status && (!where.applied_run_id || r.applied_run_id === where.applied_run_id)),
    updateMany: async ({ where, data }) => { const row = rows.find(r => r.id === where.id && r.status === where.status && (where.revision == null || r.revision === where.revision)); if (!row) return { count: 0 }; Object.assign(row, data, { revision: row.revision + 1 }); return { count: 1 } },
  }, employeeHistory: { create: async ({ data }) => { events.push(data) } } }
  const run = { id: 'R', company_id: 'A', branch_id: 'B', type: 'ORDINARIA', pay_date: new Date('2026-10-31'), payslips: [{ employee_id: 'E', lines: [{ concept: 'OTRA_DEDUCCION', amount: '20.00', deduction_id: 'D', deduction_snapshot: { id: 'D', revision: 1, amount: '20.00', reason: 'Acuerdo', target_run_id: null, employee_id: 'E' } }] }] }
  return { db, run, rows, events }
}
test('confirm applies frozen deductions once, cancellation restores them once', async () => {
  const f = fixture(), { claimDeductions, restoreDeductions } = api()
  await claimDeductions(f.db, { run: f.run, userId: null })
  assert.equal(f.rows[0].status, 'APLICADO'); assert.equal(f.rows[0].applied_run_id, 'R')
  await assert.rejects(claimDeductions(f.db, { run: f.run }), e => e.status === 409)
  await restoreDeductions(f.db, { run: f.run }); assert.equal(f.rows[0].status, 'PENDIENTE'); assert.equal(f.rows[0].applied_run_id, null)
  await restoreDeductions(f.db, { run: f.run }); assert.equal(f.rows[0].revision, 3)
  assert.deepEqual(f.events.map(e => e.event), ['DEDUCTION_APPLIED', 'DEDUCTION_RESTORED'])
})
test('a newly registered deduction invalidates the whole draft before any claim', async () => {
  const f = fixture(); f.rows.push({ ...D, id: 'new' })
  await assert.rejects(api().claimDeductions(f.db, { run: f.run }), e => e.status === 409)
  assert.ok(f.rows.every(r => r.status === 'PENDIENTE')); assert.equal(f.events.length, 0)
})
test('editing or cancelling a frozen deduction requires recalculation', async () => {
  for (const patch of [{ revision: 2, amount: '30.00' }, { status: 'CANCELADO' }]) {
    const f = fixture(); Object.assign(f.rows[0], patch)
    await assert.rejects(api().claimDeductions(f.db, { run: f.run }), e => e.status === 409)
    assert.equal(f.events.length, 0)
  }
})
