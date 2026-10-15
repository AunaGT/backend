require('./setup-env')
const test = require('node:test'), assert = require('node:assert/strict')
const { saveProvider, saveResource, listDirectory } = require('../src/modules/appointments/directory')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const scope = { companyId: id(1), branchId: id(2), branchIds: [id(2)], userId: id(3), permissions: ['appointments.configure'], isAdmin: false }
function fixture() {
  let data, employeeSelection
  const db = {
    companyModule: { findMany: async () => [{ module_code: 'appointments', status: 'ACTIVE' }] },
    systemSetting: { findUnique: async ({where}) => ({ value: where.company_id_key.key==='timezone'?'America/Guatemala':'true' }) },
    scheduleCalendar:{findFirst:async()=>null},
    branch: { findMany: async () => [{ id: id(2), name: 'Principal' }] },
    serviceProvider: { findFirst: async () => null, findMany: async () => [], create: async input => { data = input.data; return { id: id(4), ...data } } },
    serviceProviderBranch: { deleteMany: async () => ({}), createMany: async () => ({}) },
    scheduleResource: { findFirst: async () => null, findMany: async () => [], create: async input => { data = input.data; return { id: id(5), ...data } } },
    employee: { findFirst: async () => ({ id: id(6), user_id: null, branch_id: id(2), status: 'ACTIVO' }), findMany: async args => { employeeSelection = args; return [] } },
    userCompany: { findFirst: async () => null },
    appointmentSession: { findMany: async () => [] },
  }
  return { db, saved: () => data, employeeSelection: () => employeeSelection }
}
test('profesional puede vincular empleado sin cuenta y no interpreta horario libre', async () => {
  const { db, saved } = fixture()
  const result = await saveProvider(db, scope, null, { name: 'Ana', employeeId: id(6), branchIds: [id(2)], active: true })
  assert.equal(result.id, id(4)); assert.equal(saved().employee_id, id(6)); assert.equal(saved().user_id, null)
  assert.equal(Object.hasOwn(saved(), 'work_schedule'), false)
})
test('vínculo nuevo con HR desactivado, empleado duplicado o usuario ajeno se rechaza', async () => {
  const { db } = fixture()
  db.companyModule.findMany = async () => [{ module_code: 'appointments', status: 'ACTIVE' }, { module_code: 'hr', status: 'DISABLED' }]
  await assert.rejects(() => saveProvider(db, scope, null, { name: 'Ana', employeeId: id(6), branchIds: [id(2)], active: true }), { status: 403 })
  db.companyModule.findMany = async () => [{ module_code: 'appointments', status: 'ACTIVE' }]
  db.serviceProvider.findFirst = async () => ({ id: id(9) })
  await assert.rejects(() => saveProvider(db, scope, null, { name: 'Ana', employeeId: id(6), branchIds: [id(2)], active: true }), { status: 409 })
  db.serviceProvider.findFirst = async () => null
  await assert.rejects(() => saveProvider(db, scope, null, { name: 'Ana', userId: id(8), branchIds: [id(2)], active: true }), { status: 400 })
})
test('sala necesita capacidad pero un proyector no limita personas', async () => {
  const { db, saved } = fixture()
  await assert.rejects(() => saveResource(db, scope, null, { name: 'Sala', type: 'ROOM', personCapacity: null, active: true }), { status: 400 })
  await saveResource(db, scope, null, { name: 'Proyector', type: 'EQUIPMENT', personCapacity: null, active: true })
  assert.equal(saved().person_capacity, null)
  assert.equal(saved().branch_id, scope.branchId)
  await assert.rejects(() => saveResource(db, scope, null, { name: 'Sala', type: 'ROOM', personCapacity: 1, active: true, companyId: id(99) }), { status: 400 })
})
test('directorio no consulta expedientes sin configure ni cuando HR está desactivado', async () => {
  const { db, employeeSelection } = fixture()
  const own = await listDirectory(db, { ...scope, permissions: ['appointments.view'] })
  assert.deepEqual(own.employeeCandidates, [])
  assert.equal(employeeSelection(), undefined)
  await listDirectory(db, scope)
  const select = employeeSelection().select
  assert.equal(select.first_name, true)
  for (const key of ['base_salary', 'dpi', 'bank_account', 'documents']) assert.equal(Object.hasOwn(select, key), false)
})
test('archivar profesional ya vinculado no exige reactivar RRHH ni borra su identidad', async () => {
  const { db } = fixture()
  db.companyModule.findMany = async () => [{ module_code: 'appointments', status: 'ACTIVE' }, { module_code: 'hr', status: 'DISABLED' }]
  db.serviceProvider.findFirst = async ({ where }) => where.id === id(4) ? { id: id(4), employee_id: id(6), user_id: null, version: 1, branches: [{ branch_id: id(2) }] } : null
  db.serviceProvider.updateMany = async () => ({ count: 1 })
  db.employee.findFirst = async () => assert.fail('No se requiere consultar RRHH para conservar un vínculo existente')
  const result = await saveProvider(db, scope, id(4), { name: 'Ana', employeeId:id(6), userId:null, branchIds: [id(2)], active: false, expectedVersion: 1 })
  assert.equal(result.active, false)
  assert.equal(result.employeeId, id(6))
})
