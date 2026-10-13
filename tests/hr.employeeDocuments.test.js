const test = require('node:test')
const assert = require('node:assert/strict')
const employeeId = '22222222-2222-4222-8222-222222222222', documentId = '33333333-3333-4333-8333-333333333333', typeId = '44444444-4444-4444-8444-444444444444'
const req = { companyId: 'company-a', branchId: 'branch-a', user: { sub: 'user-a' }, params: { id: employeeId, documentId }, body: {}, query: {} }
async function run(action, overrides, models, sdk = {}) {
  const paths = [require.resolve('../src/models/prisma'), require.resolve('../src/modules/hr/documentStorage')]
  const file = require.resolve('../src/modules/hr/controllers/documents')
  const previous = paths.map(p => require.cache[p]); let result
  const db = { ...models, $queryRaw: async () => [{ id: employeeId }], $transaction: async fn => fn(db) }
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { prisma: db, prismaTransaction: db } }
  require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: sdk }
  delete require.cache[file]
  try { await require(file)[action]({ ...req, ...overrides }, { set: () => {}, json: value => { result = value }, status: () => ({ json: value => { result = value } }) }, e => { throw e }); return result }
  finally { delete require.cache[file]; paths.forEach((p, i) => { if (previous[i]) require.cache[p] = previous[i]; else delete require.cache[p] }) }
}
const scopedEmployee = { findFirst: async args => { assert.deepEqual(args.where, { id: employeeId, company_id: 'company-a', branch_id: 'branch-a' }); return { id: employeeId } } }
test('acceso ajeno no firma ningún documento', async () => {
  await assert.rejects(run('access', {}, { employee: { findFirst: async () => null } }, { signHrFile: () => assert.fail('No debe firmar') }), e => e.status === 404)
  await assert.rejects(run('access', {}, { employee: scopedEmployee, employeeDocument: { findFirst: async args => { assert.equal(args.where.employee_id, employeeId); assert.equal(args.where.company_id, 'company-a'); return null } } }), e => e.status === 404)
})
test('acceso autorizado emite enlace temporal sin ruta persistente', async () => {
  const result = await run('access', { body: { download: true } }, { employee: scopedEmployee, employeeDocument: { findFirst: async () => ({ storage_path: 'private', original_name: 'test.pdf' }) } }, { signHrFile: async (path, options) => { assert.equal(path, 'private'); assert.equal(options.downloadName, 'test.pdf'); return { url: 'signed', expiresAt: 'temporary' } } })
  assert.deepEqual(result, { url: 'signed', expiresAt: 'temporary' })
})
test('archivo conserva objeto y registra auditoría', async () => {
  let audit
  const result = await run('archive', {}, { employee: scopedEmployee, employeeDocument: { findFirst: async () => ({ id: documentId, type_id: typeId, archived_at: null }), update: async args => ({ id: documentId, ...args.data }) }, employeeHistory: { create: async args => { audit = args.data } } }, { removeNewHrFiles: () => assert.fail('No borrar versiones') })
  assert.ok(result.archived_at); assert.equal(audit.event, 'DOCUMENT_ARCHIVED')
})
test('restauración con otra versión vigente devuelve conflicto sin eliminar', async () => {
  await assert.rejects(run('restore', {}, { employee: scopedEmployee, employeeDocument: { findFirst: async args => args.where.id ? { id: documentId, type_id: typeId, archived_at: new Date() } : { id: 'other' } } }), e => e.status === 409)
})
test('listado documental no publica rutas ni URLs', async () => {
  const result = await run('list', {}, { employee: scopedEmployee, employeeDocument: { findMany: async args => { assert.equal(args.select.storage_path, undefined); return [{ id: documentId, type_id: typeId, archived_at: null }] } }, employeeDocumentType: { findMany: async () => [{ id: typeId, active: true, required: true }] } })
  assert.equal(result.complete, true); assert.equal(result.items[0].storage_path, undefined)
})
