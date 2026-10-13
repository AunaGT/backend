const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { Readable } = require('node:stream')

const COMPANY = '11111111-1111-4111-8111-111111111111'
const CONTACT = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'
const OLD = `${COMPANY}/contacts/${CONTACT}/44444444-4444-4444-8444-444444444444.webp`
let calls, contact, updateCount, databaseError, storageError, signError

const storage = {
  upload: async (path, buffer, options) => { calls.push({ operation: 'upload', path, buffer, options }); return storageError ? { error: storageError } : { data: { path } } },
  createSignedUrls: async (paths, ttl) => { calls.push({ operation: 'sign', paths, ttl }); return signError ? { error: signError } : { data: paths.map(path => ({ path, signedUrl: `https://example.test/signed/${path}` })) } },
  remove: async paths => { calls.push({ operation: 'remove', paths }); return {} },
}
const prisma = { supplier: {
  findFirst: async args => { calls.push({ operation: 'find', args }); return contact },
  updateMany: async args => { calls.push({ operation: 'update', args }); if (databaseError) throw databaseError; return { count: updateCount } },
} }
// Real decoding, permission checks and controller; database/storage I/O stays offline.
function substitute(moduleName, exports) {
  const path = require.resolve(moduleName)
  const previous = require.cache[path]
  require.cache[path] = { id: path, filename: path, loaded: true, exports }
  return () => { if (previous) require.cache[path] = previous; else delete require.cache[path] }
}
const restoreStorage = substitute('../src/services/supabaseStorage', { assertSupabase: () => ({ storage: { from: bucket => { assert.equal(bucket, 'contacts'); return storage } } }) })
const restorePrisma = substitute('../src/models/prisma', { prisma, prismaTransaction: prisma })
const images = require('../src/modules/contacts/imageStorage')
const controller = require('../src/modules/contacts/controller')
restoreStorage()
restorePrisma()

test.beforeEach(() => {
  calls = []
  contact = { id: CONTACT, party_type: 'CUSTOMER', image_storage_path: OLD }
  updateCount = 1
  databaseError = storageError = signError = null
})
async function photo(width = 2, height = 2) {
  return { mimetype: 'image/png', buffer: await sharp({ create: { width, height, channels: 3, background: '#ff7800' } }).png().toBuffer() }
}
async function upload(overrides = {}) {
  let response, status = 200, error
  await controller.uploadImage({ params: { id: CONTACT }, companyId: COMPANY, user: { permissions: ['contacts.clients.edit'] }, file: await photo(), ...overrides }, {
    status(code) { status = code; return this }, json(data) { response = data }, set() {},
  }, value => { error = value })
  return { response, status, error }
}

test('a real image is normalized, bounded and stored under its tenant/contact then signed', async () => {
  const path = await images.uploadContactImage(COMPANY, CONTACT, await photo(1600, 400))
  assert.ok(path.startsWith(`${COMPANY}/contacts/${CONTACT}/`))
  const file = calls.find(call => call.operation === 'upload')
  assert.deepEqual(file.options, { upsert: false, contentType: 'image/webp', cacheControl: '0' })
  const metadata = await sharp(file.buffer).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 800)
  assert.equal(metadata.height, 200)
  const [dto] = await images.contactImageDtos([{ id: CONTACT, name: 'QA', image_storage_path: path }], COMPANY)
  assert.equal(dto.image_url, `https://example.test/signed/${path}`)
  assert.equal('image_storage_path' in dto, false)
})

test('signing is batched and cannot grant a different contact or tenant the same URL', async () => {
  const rows = [
    { id: CONTACT, image_storage_path: OLD },
    { id: OTHER, image_storage_path: OLD },
    { id: OTHER, image_storage_path: `${OTHER}/contacts/${OTHER}/44444444-4444-4444-8444-444444444444.webp` },
    { id: OTHER, image_storage_path: `${COMPANY}/contacts/${OTHER}/../secret.webp` },
  ]
  const dtos = await images.contactImageDtos(rows, COMPANY)
  assert.deepEqual(calls, [{ operation: 'sign', paths: [OLD], ttl: 3600 }])
  assert.ok(dtos[0].image_url)
  assert.deepEqual(dtos.slice(1).map(dto => dto.image_url), [null, null, null])
  assert.ok(dtos.every(dto => !('image_storage_path' in dto)))
})

test('missing or unavailable photos return the default state, not a broken contact list', async () => {
  signError = new Error('Storage offline')
  const [failed, absent] = await images.contactImageDtos([{ id: CONTACT, image_storage_path: OLD }, { id: OTHER }], COMPANY)
  assert.equal(failed.image_url, null)
  assert.equal(absent.image_url, null)
})

test('invalid, disguised, empty and oversized images are rejected before storage', async () => {
  const png = await photo()
  for (const [file, status] of [
    [undefined, 400], [{ mimetype: 'image/png', buffer: Buffer.alloc(0) }, 400],
    [{ mimetype: 'image/png', buffer: Buffer.from('not an image') }, 400],
    [{ ...png, mimetype: 'image/jpeg' }, 400],
    [{ mimetype: 'image/svg+xml', buffer: Buffer.from('<svg/>') }, 400],
    [{ mimetype: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }, 413],
  ]) await assert.rejects(images.uploadContactImage(COMPANY, CONTACT, file), error => error.status === status)
  await assert.rejects(images.uploadContactImage(COMPANY, 'invalid-id', png), error => error.status === 400)
  assert.equal(calls.length, 0)
})

test('storage rejection never changes the saved photo', async () => {
  storageError = new Error('Storage unavailable')
  const result = await upload()
  assert.equal(result.error.status, 503)
  assert.ok(!calls.some(call => call.operation === 'update' || call.operation === 'remove'))
})

test('a missing contact or wrong party permission cannot upload or replace photos', async () => {
  const forbidden = await upload({ user: { permissions: ['contacts.suppliers.edit'] } })
  assert.equal(forbidden.error.status, 403)
  contact = null
  const missing = await upload()
  assert.equal(missing.status, 404)
  assert.ok(calls.every(call => call.operation === 'find'))
  assert.deepEqual(calls[0].args.where, { id: CONTACT, company_id: COMPANY, deleted: false })
})

test('malformed route IDs return a client error before any database or storage access', async () => {
  const result = await upload({ params: { id: 'not-a-uuid' } })
  assert.equal(result.status, 400)
  assert.equal(calls.length, 0)
})

test('replacement commits with tenant, party and old path guards before cleaning the old photo', async () => {
  const result = await upload()
  const uploaded = calls.find(call => call.operation === 'upload')
  const update = calls.find(call => call.operation === 'update')
  assert.deepEqual(update.args.where, { id: CONTACT, company_id: COMPANY, party_type: 'CUSTOMER', deleted: false, image_storage_path: OLD })
  assert.deepEqual(update.args.data, { image_storage_path: uploaded.path })
  assert.deepEqual(result.response, { id: CONTACT, image_url: `https://example.test/signed/${uploaded.path}` })
  assert.deepEqual(calls.filter(call => call.operation === 'remove').map(call => call.paths), [[OLD]])
  assert.ok(calls.indexOf(update) < calls.findIndex(call => call.operation === 'remove'))
})

test('database failure or concurrent replacement cleans only the uncommitted upload', async () => {
  for (const failure of ['database', 'conflict']) {
    calls = []
    databaseError = failure === 'database' ? new Error('Database offline') : null
    updateCount = failure === 'conflict' ? 0 : 1
    const result = await upload()
    assert.ok(result.error)
    if (failure === 'conflict') assert.equal(result.error.status, 409)
    const uploaded = calls.find(call => call.operation === 'upload')
    assert.deepEqual(calls.filter(call => call.operation === 'remove').map(call => call.paths), [[uploaded.path]])
  }
})

test('cleanup never deletes an object outside the exact tenant/contact prefix', async () => {
  await images.removeContactImage(OLD, COMPANY, OTHER)
  await images.removeContactImage(OLD, OTHER, CONTACT)
  await images.removeContactImage('../unsafe.webp', COMPANY, CONTACT)
  assert.equal(calls.length, 0)
})

test('the real multipart middleware accepts one photo and rejects extra fields or files', async () => {
  const restoreAuth = substitute('../src/middlewares/autenticacion', { Auth() {}, hasPermission: () => function permission() {} })
  const router = require('../src/modules/contacts/routes')
  restoreAuth()
  const parse = router.stack.find(layer => layer.route?.path === '/:id/image').route.stack.find(layer => layer.handle.name === 'checkedImageUpload').handle
  async function request(parts) {
    const boundary = 'contacts-test-boundary'
    const body = Buffer.from(parts.map(part => `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.file ? '; filename="qa.png"\r\nContent-Type: image/png' : ''}\r\n\r\nQA\r\n`).join('') + `--${boundary}--\r\n`)
    const req = Readable.from([body])
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) }
    const error = await new Promise(resolve => parse(req, {}, resolve))
    return { req, error }
  }
  const valid = await request([{ name: 'file', file: true }])
  assert.equal(valid.error, undefined)
  assert.equal(valid.req.file.buffer.toString(), 'QA')
  for (const extra of [{ name: 'caption' }, { name: 'file', file: true }]) {
    assert.equal((await request([{ name: 'file', file: true }, extra])).error.status, 400)
  }
})
