const test = require('node:test'), assert = require('node:assert/strict')
const { buildPayslip } = require('../src/services/payroll/build')
const { DEFAULT_RATES } = require('../src/services/payroll/rates')
const input = { employee: { first_name: 'Ana', last_name: 'Prueba', base_salary: '5000.00', bonificacion_incentivo: '250.00', igss_number: '123', hire_date: new Date('2020-01-01') }, run: { type: 'ORDINARIA', period_start: new Date('2026-10-01'), period_end: new Date('2026-10-31'), pay_date: new Date('2026-10-31') }, rates: DEFAULT_RATES }
const discount = { id: 'D', revision: 1, employee_id: 'E', amount: '125.50', reason: 'Acuerdo del empleado', target_run_id: null }
test('manual salary deductions affect net only and keep individual frozen reasons', () => {
  const original = buildPayslip(input), actual = buildPayslip({ ...input, deductions: [discount, { ...discount, id: 'D2', amount: '10.25', reason: 'Otro acuerdo' }] })
  assert.equal(actual.total_deductions, original.total_deductions + 135.75)
  assert.equal(actual.net_pay, original.net_pay - 135.75)
  for (const key of ['igss_base', 'isr_base', 'employer_cost', 'total_earnings']) assert.equal(actual[key], original[key])
  const rows = actual.lines.filter(l => l.concept === 'OTRA_DEDUCCION')
  assert.equal(rows.length, 2); assert.equal(rows[0].deduction_id, 'D'); assert.equal(rows[0].deduction_snapshot.reason, discount.reason)
})
test('manual deductions never silently become installments or negative salary', () => {
  assert.throws(() => buildPayslip({ ...input, advances: [{ id: 'A', installment: 5000, balance: 5000 }], deductions: [discount] }), e => e.status === 422 && /Ana/.test(e.message))
})
test('ordinary deductions are excluded from annual bonuses', () => {
  for (const type of ['AGUINALDO', 'BONO14']) {
    const args = { ...input, run: { ...input.run, type } }
    assert.deepEqual(buildPayslip({ ...args, deductions: [discount] }), buildPayslip(args))
  }
})
test('full reason remains frozen even when payslip description is shortened', () => {
  const result = buildPayslip({ ...input, deductions: [{ ...discount, reason: 'á'.repeat(1000) }] })
  const line = result.lines.find(l => l.concept === 'OTRA_DEDUCCION')
  assert.equal(line.deduction_snapshot.reason.length, 1000); assert.ok(line.description.length <= 150)
})
