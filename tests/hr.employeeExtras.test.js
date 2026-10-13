const test = require('node:test'), assert = require('node:assert/strict')
test('campos complementarios son opcionales, acotados y no alteran salario', () => {
  const { employeeExtras } = require('../src/modules/hr/domain/employeeExtras')
  assert.deepEqual(employeeExtras({}), {})
  assert.deepEqual(employeeExtras({ gender: ' Femenino ', nationality: '', base_salary: 900 }), { gender: 'Femenino', nationality: null })
  assert.throws(() => employeeExtras({ work_schedule: 'x'.repeat(501) }), error => error.status === 400)
  assert.throws(() => employeeExtras({ gender: {} }), error => error.status === 400)
})
test('supervisor debe ser visible de la misma empresa y nunca el mismo empleado', async () => {
  const { validateSupervisor } = require('../src/modules/hr/domain/employeeExtras'), id = '11111111-1111-4111-8111-111111111111'
  await assert.rejects(validateSupervisor({}, { company_id: 'c1', branch_id: 'b1' }, id, id), error => error.status === 400)
  await assert.rejects(validateSupervisor({ employee: { findFirst: async args => { assert.equal(args.where.company_id, 'c1'); assert.equal(args.where.branch_id, 'b1'); return null } } }, { company_id: 'c1', branch_id: 'b1' }, id), error => error.status === 404)
  assert.equal(await validateSupervisor({}, {}, ''), null)
})
