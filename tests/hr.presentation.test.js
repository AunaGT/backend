const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET ||= 'hr-presentation-test-secret-at-least-32-characters'
async function runController(name, prisma, query) {
  prisma.systemSetting ||= { findUnique: async () => ({ value: 'America/Guatemala' }) }
  prisma.attendance ||= { findMany: async () => [] }
  const db = require.resolve('../src/models/prisma')
  const file = require.resolve(`../src/modules/hr/controllers/${name}`)
  const previous = require.cache[db]
  require.cache[db] = { id: db, filename: db, loaded: true, exports: { prisma } }
  delete require.cache[file]
  let result
  try {
    await require(file).list({ companyId: 'company-a', branchId: 'branch-a', query }, { json: value => { result = value } }, e => { throw e })
    return result
  } finally { delete require.cache[file]; if (previous) require.cache[db] = previous; else delete require.cache[db] }
}
test('empleados devuelve indicadores globales del ámbito y página independiente del filtro', async () => {
  let query
  const result = await runController('employees', { employee: {
    count: async () => 21, findMany: async args => { query = args; return [] },
    groupBy: async args => { assert.deepEqual(args.where, { company_id: 'company-a', branch_id: 'branch-a' }); return [{ status: 'ACTIVO', _count: { _all: 30 } }, { status: 'BAJA', _count: { _all: 2 } }] },
  } }, { page: '2', pageSize: '10', status: 'ACTIVO', q: 'ana' })
  assert.equal(query.skip, 10); assert.equal(query.take, 10)
  assert.equal(query.where.status, 'ACTIVO')
  assert.ok(query.where.OR.some(item => item.email?.contains === 'ana'))
  assert.deepEqual(result.summary, { total: 32, active: 30, onLeave: 0, inactive: 2, suspended: 0, terminated: 2 })
})
test('paginación inválida de empleados conserva límites enteros seguros', async () => {
  let query
  await runController('employees', { employee: { count: async () => 30, findMany: async args => { query = args; return [] }, groupBy: async () => [] } }, { page: 'abc', pageSize: 'Infinity' })
  assert.equal(query.skip, 0); assert.equal(query.take, 50)
})
test('filtros de puesto y sucursal no amplían el ámbito autorizado', async () => {
  let query
  await runController('employees', { employee: { count: async () => 0, findMany: async args => { query = args; return [] }, groupBy: async () => [] } }, { position: 'Bodega', branch_id: '11111111-1111-4111-8111-111111111111' })
  assert.equal(query.where.position.contains, 'Bodega')
  assert.equal(query.where.branch_id, 'branch-a')
  assert.deepEqual(query.where.AND, [{ branch_id: '11111111-1111-4111-8111-111111111111' }])
})
test('licencia cuenta empleados activos una sola vez sin convertir suspensión en licencia', async () => {
  const result = await runController('employees', { employee: { count: async () => 0, findMany: async () => [], groupBy: async () => [{ status: 'ACTIVO', _count: { _all: 4 } }, { status: 'SUSPENDIDO', _count: { _all: 1 } }, { status: 'BAJA', _count: { _all: 2 } }] }, attendance: { findMany: async args => { assert.deepEqual(args.where.employee, { company_id: 'company-a', status: 'ACTIVO', branch_id: 'branch-a' }); assert.deepEqual(args.distinct, ['employee_id']); return [{ employee_id: 'e1' }, { employee_id: 'e2' }] } } }, {})
  assert.equal(result.summary.active, 2); assert.equal(result.summary.onLeave, 2); assert.equal(result.summary.inactive, 3); assert.equal(result.summary.total, 7)
})
test('anticipos pagina sin perder filtros de empresa sucursal y empleado', async () => {
  let query
  const result = await runController('advances', { employeeAdvance: { count: async () => 25, findMany: async args => { query = args; return [] } } }, { page: '2', pageSize: '10', employee_id: 'employee-a', status: 'PENDIENTE' })
  assert.equal(query.take, 10); assert.equal(query.skip, 10)
  assert.deepEqual(query.where, { company_id: 'company-a', branch_id: 'branch-a', employee_id: 'employee-a', status: 'PENDIENTE' })
  assert.equal(result.totalPages, 3); assert.equal(result.totalItems, 25)
})
test('asistencia limita la lectura a los empleados visibles sin perder el aislamiento', async () => {
  let query
  await runController('attendance', { attendance: { findMany: async args => { query = args; return [] } } }, { employee_ids: 'e1,e2', from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual(query.where.employee_id, { in: ['e1', 'e2'] }); assert.equal(query.where.company_id, 'company-a'); assert.equal(query.where.branch_id, 'branch-a')
})
