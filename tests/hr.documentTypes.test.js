const test = require('node:test')
const assert = require('node:assert/strict')
const dbPath = require.resolve('../src/models/prisma')
async function run(action, req, model) {
  const modulePath = require.resolve('../src/modules/hr/controllers/documentTypes')
  const prior = require.cache[dbPath]
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: { employeeDocumentType: model } } }
  delete require.cache[modulePath]
  let result
  try { await require(modulePath)[action](req, { json: v => { result = v }, status: () => ({ json: v => { result = v } }) }, e => { throw e }); return result }
  finally { delete require.cache[modulePath]; if (prior) require.cache[dbPath] = prior; else delete require.cache[dbPath] }
}
const req = { companyId: 'company-a', user: { permissions: ['settings.manage'] }, query: {}, params: {}, body: { name: ' DPI ' } }
test('alta de requisito usa empresa autenticada y es opcional por defecto', async () => {
  const result = await run('create', { ...req, body: { ...req.body, company_id: 'company-b' } }, { create: async args => args.data })
  assert.equal(result.company_id, 'company-a'); assert.equal(result.required, false); assert.equal(result.name, 'DPI')
})
test('catálogo activo no expone inactivos y ordenar es estable', async () => {
  await run('list', { ...req, user: { permissions: ['hr.employees.create'] } }, { findMany: async args => {
    assert.deepEqual(args.where, { company_id: 'company-a', active: true }); assert.deepEqual(args.orderBy, [{ sort_order: 'asc' }, { id: 'asc' }]); return []
  } })
})
test('lectura administrativa y escritura requieren permisos correctos', async () => {
  await assert.rejects(run('list', { ...req, user: { permissions: ['hr.employees.create'] }, query: { includeInactive: '1' } }, {}), e => e.status === 403)
  await assert.rejects(run('create', { ...req, user: { permissions: ['settings.view'] } }, {}), e => e.status === 403)
})
test('tipo ajeno no se puede renombrar ni desactivar', async () => {
  await assert.rejects(run('update', { ...req, params: { typeId: '33333333-3333-4333-8333-333333333333' } }, { findFirst: async args => { assert.equal(args.where.company_id, 'company-a'); return null } }), e => e.status === 404)
})
test('renombrar y desactivar no borra versiones existentes', async () => {
  const result = await run('update', { ...req, params: { typeId: '33333333-3333-4333-8333-333333333333' }, body: { name: 'Identificación', active: false } }, { findFirst: async () => ({ id: 'type-a' }), update: async args => args.data })
  assert.equal(result.active, false); assert.equal(result.name, 'Identificación')
})
