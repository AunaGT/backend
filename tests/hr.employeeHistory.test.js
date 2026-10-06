const test = require('node:test'), assert = require('node:assert/strict')
const dbPath = require.resolve('../src/models/prisma')
async function run(action, models, query = {}, permissions = []) {
  const file = require.resolve('../src/modules/hr/controllers/employeeHistory'), prior = require.cache[dbPath]
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: models } }; delete require.cache[file]
  let result
  try { await require(file)[action]({ companyId: 'c1', branchId: 'b1', user: { permissions }, params: { id: '22222222-2222-4222-8222-222222222222' }, query }, { set: () => {}, json: value => { result = value } }, e => { throw e }); return result }
  finally { delete require.cache[file]; if (prior) require.cache[dbPath] = prior; else delete require.cache[dbPath] }
}
test('historial ajeno no se consulta', async () => {
  await assert.rejects(run('list', { employee: { findFirst: async args => { assert.equal(args.where.company_id, 'c1'); assert.equal(args.where.branch_id, 'b1'); return null } } }), e => e.status === 404)
})
test('resumen usa agregaciones reales y no consulta datos sin permiso', async () => {
  const models = { employee: { findFirst: async () => ({ id: 'e1' }) }, employeeHistory: { count: async () => 2 }, attendance: { groupBy: async () => [{ status: 'PRESENTE', _count: { _all: 3 } }, { status: 'TARDE', _count: { _all: 1 } }, { status: 'AUSENTE', _count: { _all: 1 } }] }, employeeAdvance: { aggregate: async () => ({ _count: { _all: 1 }, _sum: { balance: '50.00' } }) } }
  const visible = await run('overview', models, { month: '2026-10' }, ['hr.attendance.view', 'hr.advances.view'])
  assert.deepEqual(visible.attendance, { marked: 5, present: 4 }); assert.deepEqual(visible.advances, { count: 1, balance: '50.00' }); assert.equal(visible.documents, null)
  const restricted = await run('overview', { employee: models.employee, employeeHistory: models.employeeHistory }, { month: '2026-10' })
  assert.equal(restricted.attendance, null); assert.equal(restricted.advances, null)
})
test('mes inválido se rechaza', async () => {
  await assert.rejects(run('overview', { employee: { findFirst: async () => ({}) } }, { month: '2026-99' }), e => e.status === 400)
})
