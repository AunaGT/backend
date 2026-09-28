const test = require('node:test')
const assert = require('node:assert/strict')

test('rechaza un responsable no asignado a la sucursal', async () => {
  const prismaPath = require.resolve('../src/models/prisma')
  const tenantPath = require.resolve('../src/middlewares/tenant')
  const previous = require.cache[prismaPath]
  const previousTenant = require.cache[tenantPath]
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma: {
    branch: { findFirst: async () => ({ id: 'branch-1' }) },
    userBranch: { findUnique: async () => null },
    $transaction: async () => { throw new Error('No debe actualizar') },
  } } }
  require.cache[tenantPath] = { id: tenantPath, filename: tenantPath, loaded: true, exports: { hasPerm: () => true } }
  delete require.cache[require.resolve('../src/modules/branches/controller')]
  const controller = require('../src/modules/branches/controller')
  const req = { params: { id: 'branch-1' }, companyId: 'company-1', body: { manager_user_id: 'outsider' } }
  let status = 200
  let response
  const res = { status(value) { status = value; return this }, json(value) { response = value; return this } }
  let error
  try {
    await controller.update(req, res, (err) => { error = err })
    assert.equal(error, undefined)
    assert.equal(status, 400)
    assert.match(response.message, /responsable/i)
  } finally {
    delete require.cache[require.resolve('../src/modules/branches/controller')]
    if (previous) require.cache[prismaPath] = previous
    else delete require.cache[prismaPath]
    if (previousTenant) require.cache[tenantPath] = previousTenant
    else delete require.cache[tenantPath]
  }
})
