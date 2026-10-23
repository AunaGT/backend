const test = require('node:test'), assert = require('node:assert/strict')
const EMP = '11111111-1111-4111-8111-111111111111'
const api = () => require('../src/services/payroll/deductions')
test('manual deductions preserve exact cents and reject malformed money/reasons', () => {
  const { parseDeductionInput } = api()
  assert.deepEqual(parseDeductionInput({ employee_id: EMP, amount: '125.50', reason: '  Acuerdo del empleado  ', target_run_id: null }), { employeeId: EMP, amount: '125.50', reason: 'Acuerdo del empleado', targetRunId: null })
  assert.equal(parseDeductionInput({ employee_id: EMP, amount: '9999999999.99', reason: 'Límite' }).amount, '9999999999.99')
  for (const amount of [true, {}, [], '', '0', '-1', '1.001', '1e2', 'NaN', '10000000000.00', 100]) assert.throws(() => parseDeductionInput({ employee_id: EMP, amount, reason: 'Motivo' }), e => e.status === 400)
  for (const reason of ['', '  ', 'a'.repeat(1001), {}]) assert.throws(() => parseDeductionInput({ employee_id: EMP, amount: '1', reason }), e => e.status === 400)
  assert.throws(() => parseDeductionInput({ employee_id: 'wrong', amount: '1', reason: 'Motivo' }), e => e.status === 404)
})
test('revision checks reject stale, cancelled and applied deductions', () => {
  const { assertPendingRevision } = api()
  assertPendingRevision({ status: 'PENDIENTE', revision: 2 }, 2)
  for (const value of [1, '2', null, true]) assert.throws(() => assertPendingRevision({ status: 'PENDIENTE', revision: 2 }, value), e => e.status === 409)
  for (const status of ['APLICADO', 'CANCELADO']) assert.throws(() => assertPendingRevision({ status, revision: 2 }, 2), e => e.status === 409)
})
test('specific payroll target must be an ordinary future draft containing the employee', async () => {
  const { validateDeductionTarget } = api(), now = new Date('2026-10-20T18:00:00Z')
  let run = { id: EMP, type: 'ORDINARIA', status: 'BORRADOR', pay_date: new Date('2026-10-31T00:00Z'), payslips: [{ employee_id: EMP }] }
  const db = { payrollRun: { findFirst: async ({ where }) => { assert.equal(where.company_id, 'A'); assert.equal(where.branch_id, 'B'); return run } } }
  await validateDeductionTarget(db, { companyId: 'A', branchId: 'B' }, EMP, EMP, now)
  for (const patch of [{ type: 'BONO14' }, { status: 'CONFIRMADA' }, { pay_date: new Date('2026-10-19T00:00Z') }, { payslips: [] }]) {
    const original = run; run = { ...run, ...patch }
    await assert.rejects(validateDeductionTarget(db, { companyId: 'A', branchId: 'B' }, EMP, EMP, now), e => e.status === 422); run = original
  }
  run = null
  await assert.rejects(validateDeductionTarget(db, { companyId: 'A', branchId: 'B' }, EMP, EMP, now), e => e.status === 404)
})
