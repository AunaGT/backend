const test = require('node:test')
const assert = require('node:assert/strict')
const requestId = '33333333-3333-4333-8333-333333333333'
const ctx = { companyId: '11111111-1111-4111-8111-111111111111', branchId: '22222222-2222-4222-8222-222222222222', userId: '44444444-4444-4444-8444-444444444444' }
const payload = { first_name: 'Ana', last_name: 'Test', branch_id: ctx.branchId, hire_date: new Date('2026-10-01'), base_salary: 100 }
const selection = { typeId: '55555555-5555-4555-8555-555555555555', file: { buffer: Buffer.from('%PDF-1.7\n'), size: 9, originalname: 'test.pdf', mimetype: 'application/pdf' } }
async function run(options, execute) {
  const dbPath = require.resolve('../src/models/prisma'), storagePath = require.resolve('../src/modules/hr/documentStorage'), appPath = require.resolve('../src/modules/hr/employeeApplication')
  const previous = [require.cache[dbPath], require.cache[storagePath]]
  const state = { employees: [], documents: [], history: [], uploaded: [], removed: [], inTransaction: false }
  const types = options.required ? [{ id: selection.typeId, name: 'DPI', active: true, required: true }] : []
  const db = {
    employeeDocumentType: { findMany: async () => options.policyChanges && state.inTransaction ? [{ id: 'changed', name: 'Nuevo requisito', active: true, required: true }] : types },
    employee: {
      findFirst: async args => args.where.creation_request_id ? state.employees.find(e => e.creation_request_id === args.where.creation_request_id && e.company_id === args.where.company_id) || null : null,
      create: async args => { if (options.dbFails) throw new Error('database unavailable'); const value = { ...args.data }; state.employees.push(value); return value },
    },
    employeeDocument: { create: async args => { state.documents.push(args.data); return args.data } },
    employeeHistory: { create: async args => { state.history.push(args.data); return args.data } },
    $transaction: async fn => { state.inTransaction = true; try { return await fn(db) } finally { state.inTransaction = false } },
  }
  const storage = {
    uploadHrFile: async args => { assert.equal(state.inTransaction, false); if (options.storageFails) throw new Error('storage unavailable'); const path = `${args.employeeId}/new.pdf`; state.uploaded.push(path); return { path } },
    removeNewHrFiles: async paths => { state.removed.push(...paths) },
  }
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db, prismaTransaction: db } }
  require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: storage }
  delete require.cache[appPath]
  try { await execute(require(appPath).createEmployeeWithDocuments, state) }
  finally { delete require.cache[appPath]; [dbPath, storagePath].forEach((p, i) => { if (previous[i]) require.cache[p] = previous[i]; else delete require.cache[p] }) }
}
test('JSON sin requisitos crea empleado y auditoría sin carga', () => run({}, async (create, state) => {
  await create(ctx, payload, [], requestId); assert.equal(state.employees.length, 1); assert.equal(state.history.length, 1); assert.equal(state.uploaded.length, 0)
}))
test('requisito faltante y duplicado impiden cualquier persistencia', () => run({ required: true }, async (create, state) => {
  await assert.rejects(create(ctx, payload, [], requestId), e => e.status === 422)
  await assert.rejects(create(ctx, payload, [selection, selection], requestId), e => e.status === 400)
  assert.equal(state.employees.length, 0); assert.equal(state.uploaded.length, 0)
}))
test('respuesta perdida permite reintento sin duplicación y contenido diferente devuelve 409', () => run({ required: true }, async (create, state) => {
  const first = await create(ctx, payload, [selection], requestId)
  const second = await create(ctx, payload, [selection], requestId)
  assert.equal(first.id, second.id); assert.equal(state.employees.length, 1); assert.equal(state.documents.length, 1); assert.equal(state.uploaded.length, 1)
  assert.equal(second.creation_request_hash, undefined)
  await assert.rejects(create(ctx, { ...payload, first_name: 'Otro' }, [selection], requestId), e => e.status === 409)
}))
test('fallo de base limpia solo objetos nuevos y no deja empleado', () => run({ required: true, dbFails: true }, async (create, state) => {
  await assert.rejects(create(ctx, payload, [selection], requestId)); assert.deepEqual(state.removed, state.uploaded); assert.equal(state.employees.length, 0); assert.equal(state.documents.length, 0)
}))
test('fallo de almacenamiento no crea empleado', () => run({ required: true, storageFails: true }, async (create, state) => {
  await assert.rejects(create(ctx, payload, [selection], requestId)); assert.equal(state.employees.length, 0); assert.equal(state.documents.length, 0)
}))
test('política modificada antes de guardar devuelve conflicto y conserva selección', () => run({ policyChanges: true }, async (create, state) => {
  await assert.rejects(create(ctx, payload, [], requestId), e => e.status === 409 && e.missingTypeIds[0] === 'changed'); assert.equal(state.employees.length, 0)
}))
