const test = require('node:test')
const assert = require('node:assert/strict')

test('precarga roles y correos una vez para el lote', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const accessPath = require.resolve('../src/services/userAccess')
  const servicePath = require.resolve('../src/services/userBulkImport')
  let roleQueries = 0
  let emailQueries = 0
  const progress = []
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    role: { findMany: async () => { roleQueries++; return [{ id: 'role-a', company_id: 'co-a', permissions: [] }] } },
    user: { findMany: async () => { emailQueries++; return [] }, create: async () => ({}) },
  } } }
  require.cache[accessPath] = { id: accessPath, filename: accessPath, loaded: true, exports: { assertGrant() {}, fail() { throw Error('invalid') } } }
  delete require.cache[servicePath]
  try {
    const { bulkCreateUsers } = require(servicePath)
    const rows = ['a@example.test', 'b@example.test'].map((email, index) => ({ rowIndex: index + 2, data: { email, name: email, password: 'strong-pass-123', role_id: 'role-a' } }))
    const result = await bulkCreateUsers(rows, { companyId: 'co-a', user: { id: 'admin' } }, event => progress.push(event))
    assert.equal(result.created, 2)
    assert.equal(roleQueries, 1)
    assert.equal(emailQueries, 1)
    assert.equal(progress.at(-1).processed, 2)
  } finally {
    delete require.cache[servicePath]
    delete require.cache[accessPath]
    delete require.cache[prismaPath]
  }
})

test('busca correos de la plantilla aunque la columna use el alias español', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const accessPath = require.resolve('../src/services/userAccess')
  const servicePath = require.resolve('../src/services/userBulkImport')
  let queriedEmails
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    role: { findMany: async () => [] },
    user: { findMany: async ({ where }) => { queriedEmails = where.email.in; return [] } },
  } } }
  require.cache[accessPath] = { id: accessPath, filename: accessPath, loaded: true, exports: { assertGrant() {}, fail() { throw Error('invalid') } } }
  delete require.cache[servicePath]
  try {
    const { bulkValidateUsers } = require(servicePath)
    await bulkValidateUsers([{ Correo_Electronico: 'A@Example.Test' }], {}, { companyId: 'co-a', user: {} })
    assert.deepEqual(queriedEmails, ['a@example.test'])
  } finally {
    delete require.cache[servicePath]
    delete require.cache[accessPath]
    delete require.cache[prismaPath]
  }
})
