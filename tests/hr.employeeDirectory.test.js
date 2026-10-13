const test = require('node:test'), assert = require('node:assert/strict')
const dbPath = require.resolve('../src/models/prisma')
async function run(query, permissions, employee) {
  const file = require.resolve('../src/modules/hr/controllers/employeeDirectory'), prior = require.cache[dbPath]
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { employee } } }; delete require.cache[file]
  let result
  try { await require(file).list({ companyId: 'company-a', branchId: 'branch-a', user: { permissions }, query }, { json: value => { result = value } }, e => { throw e }); return result }
  finally { delete require.cache[file]; if (prior) require.cache[dbPath] = prior; else delete require.cache[dbPath] }
}
test('asistencia consulta directorio mínimo sin expedientes ni salario', async () => {
  await run({ purpose: 'attendance', q: 'ana', page: '2', pageSize: '8' }, ['hr.attendance.view'], { count: async () => 20, findMany: async args => {
    assert.equal(args.where.company_id, 'company-a'); assert.equal(args.where.branch_id, 'branch-a'); assert.equal(args.skip, 8); assert.equal(args.take, 8)
    for (const key of ['dpi', 'base_salary', 'photo_storage_path', 'email', 'user']) assert.equal(args.select[key], undefined)
    assert.deepEqual(args.orderBy.at(-1), { id: 'asc' }); return []
  } })
})
test('propósito inválido o sin permiso no consulta empleados', async () => {
  await assert.rejects(run({ purpose: 'salary' }, ['hr.attendance.view'], {}), e => e.status === 400)
  await assert.rejects(run({ purpose: 'supervisor' }, ['hr.attendance.view'], {}), e => e.status === 403)
})
