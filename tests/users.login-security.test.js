const test = require('node:test')
const assert = require('node:assert/strict')
const bcrypt = require('bcryptjs')
process.env.JWT_SECRET ||= require('node:crypto').randomBytes(32).toString('hex')

test('un usuario sin empresa activa no recibe una sesión al iniciar', async t => {
  const model = require.resolve('../src/models/prisma')
  const controllerPath = require.resolve('../src/modules/users/controller')
  const oldModel = require.cache[model], oldController = require.cache[controllerPath]
  let sessions = 0
  require.cache[model] = { exports: { prisma: {
    user: {
      findUnique: async () => ({ id: 'u1', email: 'test@example.com', password: await bcrypt.hash('password1234', 4), user_companies: [{ company_id: 'c1', status: 'BLOCKED' }] }),
      update: async () => { sessions++; },
    },
  } } }
  delete require.cache[controllerPath]
  t.after(() => { if (oldModel) require.cache[model] = oldModel; else delete require.cache[model]; if (oldController) require.cache[controllerPath] = oldController; else delete require.cache[controllerPath] })
  const controller = require(controllerPath)
  let status, body, error
  await controller.login({ body: { email: 'test@example.com', password: 'password1234' } }, { status: code => { status = code; return { json: value => { body = value } } } }, e => { error = e })
  assert.equal(error, undefined)
  assert.equal(status, 403)
  assert.match(body.message, /acceso/i)
  assert.equal(sessions, 0)
})

test('una contraseña temporal limita la sesión al cambio de contraseña', async () => {
  const { crearToken } = require('../src/services/jwt')
  const { Auth } = require('../src/middlewares/autenticacion')
  const { ACCESS_COOKIE } = require('../src/config/security')
  const user = { id: 'u1', role: { name: 'lector' }, user_companies: [{ company_id: 'c1', status: 'ACTIVE' }], must_change_password: true }
  const cookies = { [ACCESS_COOKIE]: crearToken(user) }
  const check = async path => {
    let status, nextCalled = false
    await Auth({ path, cookies, headers: {}, sessionUser: user, companyId: 'c1' }, { status: code => { status = code; return { send: () => {} } } }, () => { nextCalled = true })
    return { status, nextCalled }
  }
  assert.deepEqual(await check('/users'), { status: 403, nextCalled: false })
  assert.deepEqual(await check('/me/password'), { status: undefined, nextCalled: true })
})
