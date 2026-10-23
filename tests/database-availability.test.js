const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jwt-simple')
const { secret } = require('../src/config/security')

function loadMiddleware(t, userQuery) {
  const modelPath = require.resolve('../src/models/prisma')
  const tenantPath = require.resolve('../src/middlewares/tenant')
  const previousModel = require.cache[modelPath], previousTenant = require.cache[tenantPath]
  require.cache[modelPath] = { exports: { prisma: { $queryRaw:async()=>{const row=await userQuery();return row?[{...row,_session_roles:[],_session_valid:true,_password_required:false}]:[]} } } }
  delete require.cache[tenantPath]
  t.after(() => {
    if (previousModel) require.cache[modelPath] = previousModel; else delete require.cache[modelPath]
    if (previousTenant) require.cache[tenantPath] = previousTenant; else delete require.cache[tenantPath]
  })
  return require(tenantPath).resolveTenant
}

function request(path = '/cash-sessions/current') {
  return { path, method: 'GET', headers: { authorization: 'Bearer ' + jwt.encode({ sub: 'qa-user', exp: Math.floor(Date.now() / 1000) + 3600 }, secret) } }
}
function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this }, send(body) { this.body = body; return this } }
}

test('database failure during tenant session lookup is forwarded, not returned as 401', async t => {
  const error = Object.assign(new Error('internal database address'), { code: 'P1001', name: 'PrismaClientKnownRequestError' })
  const middleware = loadMiddleware(t, async () => { throw error })
  const res = response()
  let forwarded
  await middleware(request(), res, error => { forwarded = error })
  assert.equal(res.statusCode, null)
  assert.equal(forwarded, error)
})

test('a truly expired session still responds 401', async t => {
  const middleware = loadMiddleware(t, async () => null)
  const res = response()
  await middleware(request(), res, () => { assert.fail('Invalid session must not pass') })
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.message, 'La sesión ha caducado')
})

test('database failure on auth me is also unavailable rather than an invalid token', async t => {
  const error = Object.assign(new Error('internal database address'), { errorCode: 'P1001', name: 'PrismaClientInitializationError' })
  loadMiddleware(t, async () => { throw error })
  const { Auth } = require('../src/middlewares/autenticacion')
  const { errorHandler } = require('../src/middlewares/errorHandler')
  const res = response()
  const original = console.error
  console.error = () => {}
  t.after(() => { console.error = original })
  await Auth(request('/me'), res, error => {
    assert.ok(error, 'Unavailable database must not authorize the request')
    errorHandler(error, {}, res, () => {})
  })
  assert.equal(res.statusCode, 503)
})

test('blocked platform access still responds 403', async t => {
  const middleware = loadMiddleware(t, async () => ({ id: 'qa-user', auth_version: 0, user_companies: [{ status: 'BLOCKED' }] }))
  const res = response()
  await middleware(request(), res, () => { assert.fail('Blocked membership must not pass') })
  assert.equal(res.statusCode, 403)
})

test('database initialization and connection failures return a safe 503 response', async t => {
  const { errorHandler } = require('../src/middlewares/errorHandler')
  const original = console.error
  console.error = () => {}
  t.after(() => { console.error = original })
  for (const error of [{ code: 'P1001' }, { errorCode: 'P1001' }, { code: 'P1002' }, { code: 'P1017' }, { code: 'P2024' }]) {
    const res = response()
    errorHandler({ ...error, message: 'Internal Prisma query and database address' }, {}, res, () => {})
    assert.equal(res.statusCode, 503)
    assert.match(res.body.message, /temporalmente|conexión/i)
    assert.doesNotMatch(JSON.stringify(res.body), /Prisma|database address/)
  }
})

test('other server errors and explicit validation statuses are preserved', async t => {
  const { errorHandler } = require('../src/middlewares/errorHandler')
  const original = console.error
  console.error = () => {}
  t.after(() => { console.error = original })
  for (const [error, expected] of [[{ message: 'Unexpected error' }, 500], [{ status: 400, message: 'Invalid input' }, 400], [{ code: 'P2022', message: 'Schema mismatch' }, 500]]) {
    const res = response()
    errorHandler(error, {}, res, () => {})
    assert.equal(res.statusCode, expected)
  }
})

test('a response already sent forwards the error without trying to send another response', () => {
  const { errorHandler } = require('../src/middlewares/errorHandler')
  const error = { code: 'P1001' }
  const original = console.error
  console.error = () => {}
  try {
    let forwarded
    errorHandler(error, {}, { headersSent: true, status() { assert.fail('Cannot send twice') } }, value => { forwarded = value })
    assert.equal(forwarded, error)
  } finally { console.error = original }
})
