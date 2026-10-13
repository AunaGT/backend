const test = require('node:test')
const assert = require('node:assert/strict')

function load(t, prisma) {
  const model = require.resolve('../src/models/prisma')
  const controller = require.resolve('../src/controllers/companies.controller')
  const oldModel = require.cache[model], oldController = require.cache[controller]
  require.cache[model] = { exports: { prisma } }
  delete require.cache[controller]
  t.after(() => {
    if (oldModel) require.cache[model] = oldModel; else delete require.cache[model]
    if (oldController) require.cache[controller] = oldController; else delete require.cache[controller]
  })
  return require(controller)
}

test('una empresa no puede anexar una identidad compartida por otra empresa', async t => {
  let wrote = false
  const controller = load(t, {
    userCompany: { findUnique: async () => ({ status: 'ACTIVE' }), upsert: async () => { wrote = true } },
    user: { findUnique: async () => ({ id: 'target', role: { name: 'admin', permissions: [] }, user_companies: [{ company_id: 'foreign' }] }) },
  })
  let responseStatus
  const res = { status(code) { responseStatus = code; return this }, json() {} }
  await controller.addUser({ params: { id: 'current', userId: 'target' }, companyId: 'current', user: { sub: 'actor', role: { name: 'admin' } } }, res, e => { throw e })
  assert.equal(responseStatus, 404)
  assert.equal(wrote, false)
})

test('asignación masiva no puede anexar identidades de otra empresa', async t => {
  let wrote = false
  const controller = load(t, {
    $transaction: async fn => fn({
      $queryRaw: async () => [],
      userCompany: { findMany: async () => [{ user_id: 'actor', status: 'ACTIVE', role: { name: 'admin' }, user: { role: { name: 'admin' } } }], deleteMany: async () => { wrote = true } },
      userBranch: { deleteMany: async () => { wrote = true } },
    }),
  })
  let error
  await controller.assignUsers({ params: { id: 'current' }, companyId: 'current', user: { sub: 'actor', role: { name: 'admin' } }, body: { user_ids: ['actor', 'target'] } }, { json() {} }, e => { error = e })
  assert.equal(error?.status, 404)
  assert.equal(wrote, false)
})

test('no permite retirar al último administrador de una empresa', async t => {
  let wrote = false
  const controller = load(t, {
    userCompany: { findUnique: async () => ({ status: 'ACTIVE' }) },
    $transaction: async fn => fn({
      $queryRaw: async () => [],
      userCompany: { findUnique: async () => ({ status: 'ACTIVE', role: { name: 'admin' }, user: { role: { name: 'admin' } } }), count: async () => 0, deleteMany: async () => { wrote = true } },
      userBranch: { deleteMany: async () => { wrote = true }, findFirst: async () => null },
      user: { update: async () => { wrote = true } },
    }),
  })
  let error
  await controller.removeUser({ params: { id: 'current', userId: 'target' }, companyId: 'current', user: { sub: 'actor' } }, { json() {} }, e => { error = e })
  assert.equal(error?.status, 409)
  assert.equal(wrote, false)
})
