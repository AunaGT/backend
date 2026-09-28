const test = require('node:test')
const assert = require('node:assert/strict')
process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex')

function load(t, prisma) {
  const model = require.resolve('../src/models/prisma')
  const controller = require.resolve('../src/modules/users/adminController')
  const oldModel = require.cache[model], oldController = require.cache[controller]
  require.cache[model] = { exports: { prisma } }; delete require.cache[controller]
  t.after(() => { if (oldModel) require.cache[model] = oldModel; else delete require.cache[model]; if (oldController) require.cache[controller] = oldController; else delete require.cache[controller] })
  return require(controller)
}
test('crear usuario rechaza estado desconocido antes de escribir', async t => {
  let wrote = false
  const controller = load(t, { role: { findFirst: async () => ({ id: 2, name: 'lector', permissions: [] }) }, $transaction: async () => { wrote = true; throw new Error('no debe escribir') } })
  let error
  await controller.register({ companyId: 'a', user: { sub: 'actor', permissions: [] }, body: { name: 'Persona', email: 'persona@example.test', password: 'correct-password', role_id: 2, access_status: 'UNKNOWN' } }, {}, e => { error = e })
  assert.equal(error?.status, 400)
  assert.equal(wrote, false)
})
test('la búsqueda incluye el rol efectivo de la empresa activa', async t => {
  let filter
  const controller = load(t, { user: {
    count: async ({ where }) => { filter = where; return 0 },
    findMany: async () => [],
  } })
  let response
  await controller.list({ companyId: 'company-a', query: { search: 'ventas' } }, { json: value => { response = value } }, e => { throw e })
  assert.equal(response.totalItems, 0)
  const search = filter.AND[1].OR
  assert.equal(search.length, 4)
  assert.deepEqual(search[2], { user_companies: { some: { company_id: 'company-a', role: { name: { contains: 'ventas', mode: 'insensitive' } } } } })
  assert.deepEqual(search[3], { role: { name: { contains: 'ventas', mode: 'insensitive' } }, user_companies: { some: { company_id: 'company-a', role_id: null } } })
})
test('la actividad identifica al actor y conserva eventos de actores borrados', async t => {
  const controller = load(t, {
    user: { findFirst: async () => ({ user_companies: [{ role: { id: 1, name: 'Admin' } }], role: { id: 1, name: 'Admin' } }), findMany: async () => [{ id: 'actor-a', name: 'Ana' }] },
    userAccessEvent: { count: async () => 2, findMany: async () => [{ id: 1, actor_id: 'actor-a' }, { id: 2, actor_id: 'actor-b' }] },
  })
  let response
  await controller.activity({ companyId: 'company-a', params: { id: 'user-a' }, query: {} }, { json: value => { response = value } }, e => { throw e })
  assert.equal(response.items[0].actor_name, 'Ana')
  assert.equal(response.items[1].actor_name, null)
})
