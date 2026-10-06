const test = require('node:test'), assert = require('node:assert/strict')
test('edición y baja registran auditoría y no filtran claves privadas', async () => {
  const dbPath = require.resolve('../src/models/prisma'), file = require.resolve('../src/modules/hr/controllers/employees'), appPath = require.resolve('../src/modules/hr/employeeApplication'), prior = require.cache[dbPath]
  const current = { id: 'e1', company_id: 'c1', branch_id: 'b1', first_name: 'Ana', status: 'ACTIVO', creation_request_hash: 'secret', creation_request_id: 'key' }
  let locks = 0
  const history = [], db = { $queryRaw: async () => { locks++; return [{ id: 'e1' }] }, employee: { findFirst: async () => current, update: async args => ({ ...current, ...args.data }) }, employeeHistory: { create: async args => history.push(args.data) }, $transaction: async fn => fn(db) }
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db, prismaTransaction: db } }; delete require.cache[file]; delete require.cache[appPath]
  try {
    const controller = require(file), req = { companyId: 'c1', branchId: 'b1', user: { sub: 'u1' }, params: { id: 'e1' }, body: { first_name: 'Elena' } }, results = [], res = { set: () => {}, json: value => results.push(value) }
    await controller.update(req, res, e => { throw e }); await controller.remove({ ...req, body: {} }, res, e => { throw e })
    assert.deepEqual(history.map(item => item.event), ['EMPLOYEE_UPDATED', 'EMPLOYEE_TERMINATED'])
    for (const dto of results) { assert.equal(dto.creation_request_hash, undefined); assert.equal(dto.creation_request_id, undefined) }
    assert.equal(history[0].changes.first_name.after, 'Elena')
    assert.equal(locks, 2)
  } finally { delete require.cache[file]; delete require.cache[appPath]; if (prior) require.cache[dbPath] = prior; else delete require.cache[dbPath] }
})
test('DTO nunca expone claves de creación ni rutas privadas', async () => {
  const storagePath = require.resolve('../src/modules/hr/documentStorage'), file = require.resolve('../src/modules/hr/employeeApplication'), prior = require.cache[storagePath]
  require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { signHrFile: async path => { assert.equal(path, 'private-path'); return { url: 'temporary-url', expiresAt: 'expiry' } } } }; delete require.cache[file]
  try {
    const dto = await require(file).employeeDto({ id: 'e1', photo_url: 'legacy', photo_storage_path: 'private-path', creation_request_id: 'key', creation_request_hash: 'secret' })
    assert.deepEqual(dto, { id: 'e1', photo_url: 'temporary-url', photo_expires_at: 'expiry' })
  } finally { delete require.cache[file]; if (prior) require.cache[storagePath] = prior; else delete require.cache[storagePath] }
})
test('fotografía nueva no usa almacenamiento público ni elimina foto anterior', async () => {
  const dbPath = require.resolve('../src/models/prisma'), storagePath = require.resolve('../src/modules/hr/documentStorage'), file = require.resolve('../src/modules/hr/controllers/employees'), appPath = require.resolve('../src/modules/hr/employeeApplication')
  const prior = [require.cache[dbPath], require.cache[storagePath]], current = { id: 'e1', photo_url: 'legacy', company_id: 'c1', branch_id: 'b1' }
  let data, result
  const db = { $queryRaw: async () => [{ id: 'e1' }], employee: { findFirst: async () => current, update: async args => { data = args.data; return { ...current, ...args.data } } }, employeeHistory: { create: async () => ({}) }, $transaction: async fn => fn(db) }
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db, prismaTransaction: db } }
  require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadHrFile: async () => ({ path: 'new-private' }), signHrFile: async () => ({ url: 'temporary', expiresAt: 'expiry' }) } }
  delete require.cache[file]; delete require.cache[appPath]
  try {
    await require(file).uploadPhoto({ companyId: 'c1', branchId: 'b1', user: { sub: 'u1' }, params: { id: 'e1' }, file: { mimetype: 'image/png' } }, { set: () => {}, json: value => { result = value } }, e => { throw e })
    assert.equal(data.photo_storage_path, 'new-private'); assert.equal(data.photo_url, undefined); assert.equal(result.photo_url, 'temporary')
  } finally { delete require.cache[file]; delete require.cache[appPath]; [dbPath, storagePath].forEach((p, i) => { if (prior[i]) require.cache[p] = prior[i]; else delete require.cache[p] }) }
})
