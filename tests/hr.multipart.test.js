const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough } = require('node:stream')
// Route loading must not initialize database clients or load real auth env.
for (const [modulePath, exports] of [
  ['../src/models/prisma', { prisma: {}, prismaTransaction: {} }],
  ['../src/middlewares/autenticacion', { Auth: (_req, _res, next) => next(), hasPermission: () => (_req, _res, next) => next() }],
]) {
  const id = require.resolve(modulePath)
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
const router = require('../src/modules/hr/routes')

// Exercise the actual upload middleware registered on each HR route, without
// authentication, database or storage side effects.
async function parse(routePath, fields = [], files = [], complete = true) {
  const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods.post).route
  const middleware = route.stack[2].handle
  const boundary = 'hr-regression-boundary'
  const parts = [
    ...fields.map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    ...files.map(({ name = 'file', content = Buffer.from('%PDF-1.7\n') }) => Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), content, Buffer.from('\r\n'),
    ])),
  ]
  if (complete) parts.push(Buffer.from(`--${boundary}--\r\n`))
  const body = Buffer.concat(parts)
  const req = new PassThrough()
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) }
  req.method = 'POST'
  const error = await new Promise(resolve => { middleware(req, {}, resolve); req.end(body) })
  return { req, error }
}

test('document upload accepts exactly type_id plus one file', async () => {
  const { req, error } = await parse('/employees/:id/documents', [['type_id', '55555555-5555-4555-8555-555555555555']], [{}])
  assert.equal(error, undefined)
  assert.equal(req.body.type_id, '55555555-5555-4555-8555-555555555555')
  assert.equal(req.file.buffer.toString(), '%PDF-1.7\n')
})
test('create accepts two fields plus all 20 supported documents', async () => {
  const { req, error } = await parse('/employees', [['payload', '{}'], ['manifest', '[]']], Array.from({ length: 20 }, (_, i) => ({ name: `document_${i}` })))
  assert.equal(error, undefined)
  assert.equal(req.files.length, 20)
})
test('photo upload accepts one file', async () => {
  const { req, error } = await parse('/employees/:id/photo', [], [{}])
  assert.equal(error, undefined)
  assert.equal(req.file.originalname, 'test.pdf')
})
test('creation accepts zero or one optional document', async () => {
  for (const files of [[], [{ name: 'document_0' }]]) {
    const { req, error } = await parse('/employees', [['payload', '{}'], ['manifest', '[]']], files)
    assert.equal(error, undefined)
    assert.equal(req.files.length, files.length)
  }
})
test('upload accepts exactly 5 MB rather than rejecting the boundary', async () => {
  const { req, error } = await parse('/employees/:id/documents', [['type_id', 'type']], [{ content: Buffer.alloc(5 * 1024 * 1024) }])
  assert.equal(error, undefined)
  assert.equal(req.file.size, 5 * 1024 * 1024)
})
for (const [name, route, fields, files, complete, status] of [
  ['oversized file', '/employees/:id/documents', [], [{ content: Buffer.alloc(5 * 1024 * 1024 + 1) }], true, 413],
  ['extra files', '/employees/:id/documents', [['type_id', 'type']], [{}, {}], true, 400],
  ['too many creation files', '/employees', [['payload', '{}'], ['manifest', '[]']], Array.from({ length: 21 }, (_, i) => ({ name: `document_${i}` })), true, 400],
  ['extra fields', '/employees/:id/documents', [['type_id', 'type'], ['extra', 'value']], [], true, 400],
  ['oversized field', '/employees/:id/documents', [['type_id', 'x'.repeat(1025)]], [], true, 413],
  ['truncated multipart', '/employees/:id/documents', [['type_id', 'type']], [], false, 400],
]) test(`upload rejects ${name} with a readable client error`, async () => {
  const { error } = await parse(route, fields, files, complete)
  assert.ok(error)
  assert.equal(error.status, status)
  assert.match(error.message, /archivo|document|carga|formulario/i)
})

test('malformed employee JSON and document manifest fail before persistence', async () => {
  const create = require('../src/modules/hr/controllers/employees').create
  for (const body of [
    { payload: '{', manifest: '[]' },
    { payload: '{}', manifest: '{' },
    { payload: 'null', manifest: '[]' },
    { payload: '[]', manifest: '[]' },
    { payload: '{}', manifest: '{}' },
    { payload: '{}', manifest: '[null]' },
  ]) {
    let error
    await create({ companyId: 'company-a', body, is: () => true }, { json: () => assert.fail('Must not persist invalid data') }, value => { error = value })
    assert.equal(error?.status, 400)
    assert.match(error.message, /válid/i)
  }
})
