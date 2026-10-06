const test = require('node:test')
const assert = require('node:assert/strict')
const dependency = require.resolve('../src/services/supabaseStorage')
const modulePath = require.resolve('../src/modules/hr/documentStorage')
const companyId = '11111111-1111-4111-8111-111111111111'
const employeeId = '22222222-2222-4222-8222-222222222222'
const pdf = { buffer: Buffer.from('%PDF-1.7\n'), originalname: 'DPI.pdf', mimetype: 'application/pdf', size: 9 }
async function withSdk(sdk, run) {
  const previous = require.cache[dependency]
  require.cache[dependency] = { id: dependency, filename: dependency, loaded: true, exports: { assertSupabase: () => sdk } }
  delete require.cache[modulePath]
  try { await run(require(modulePath)) } finally { delete require.cache[modulePath]; if (previous) require.cache[dependency] = previous; else delete require.cache[dependency] }
}
function sdkFor({ bucket = { public: false }, bucketError = null, uploadError = null, signError = null } = {}) {
  const calls = { uploads: [], signs: [], removals: [], checks: 0 }
  return { calls, storage: {
    getBucket: async name => { assert.equal(name, 'hr'); calls.checks++; return { data: bucket, error: bucketError } },
    from: name => { assert.equal(name, 'hr'); return {
      upload: async (...args) => { calls.uploads.push(args); return { data: { path: args[0] }, error: uploadError } },
      createSignedUrl: async (...args) => { calls.signs.push(args); return { data: { signedUrl: 'https://storage.example/signed' }, error: signError } },
      remove: async paths => { calls.removals.push(paths); return { error: null } },
    } },
  } }
}
test('bucket público o inexistente impide subir y firmar', async () => {
  for (const bucket of [{ public: true }, null]) {
    const sdk = sdkFor({ bucket })
    await withSdk(sdk, async storage => {
      await assert.rejects(storage.uploadHrFile({ companyId, employeeId, file: pdf }), e => e.status === 503)
      await assert.rejects(storage.signHrFile(`${companyId}/employees/${employeeId}/33333333-3333-4333-8333-333333333333.pdf`, {}), e => e.status === 503)
      assert.equal(sdk.calls.uploads.length, 0); assert.equal(sdk.calls.signs.length, 0)
    })
  }
})
test('ruta aleatoria privada, sin sobrescritura, y enlaces de cinco minutos', async () => {
  const sdk = sdkFor()
  await withSdk(sdk, async storage => {
    const result = await storage.uploadHrFile({ companyId, employeeId, file: pdf })
    assert.match(result.path, new RegExp(`^${companyId}/employees/${employeeId}/[a-f0-9-]{36}\\.pdf$`))
    assert.equal(sdk.calls.uploads[0][2].upsert, false)
    assert.equal(sdk.calls.uploads[0][2].contentType, 'application/pdf')
    const signed = await storage.signHrFile(result.path, { downloadName: 'DPI.pdf' })
    assert.equal(sdk.calls.signs[0][1], 300)
    assert.deepEqual(sdk.calls.signs[0][2], { download: 'DPI.pdf' })
    assert.ok(new Date(signed.expiresAt).getTime() > Date.now())
    assert.equal(sdk.calls.checks, 2)
    await storage.removeNewHrFiles([result.path])
    assert.deepEqual(sdk.calls.removals, [[result.path]])
  })
})
test('entrada inválida no alcanza el SDK y limpieza no admite rutas arbitrarias', async () => {
  const sdk = sdkFor()
  await withSdk(sdk, async storage => {
    await assert.rejects(storage.uploadHrFile({ companyId, employeeId, file: { ...pdf, originalname: '../../DPI.pdf' } }), e => e.status === 400)
    await assert.rejects(storage.uploadHrFile({ companyId: '../outside', employeeId, file: pdf }), e => e.status === 400)
    await assert.rejects(storage.removeNewHrFiles(['../outside']), e => e.status === 400)
    assert.equal(sdk.calls.uploads.length, 0); assert.equal(sdk.calls.removals.length, 0)
  })
})
test('fallos del SDK son errores seguros sin detalles internos', async () => {
  for (const operation of ['upload', 'sign']) {
    const sdk = sdkFor(operation === 'upload' ? { uploadError: { message: 'secret internal' } } : { signError: { message: 'secret internal' } })
    await withSdk(sdk, async storage => {
      await assert.rejects(operation === 'upload' ? storage.uploadHrFile({ companyId, employeeId, file: pdf }) : storage.signHrFile(`${companyId}/employees/${employeeId}/33333333-3333-4333-8333-333333333333.pdf`, {}), e => e.status === 503 && !e.message.includes('secret'))
    })
  }
})
