const test = require('node:test'), assert = require('node:assert/strict')
const { supervise } = require('../src/modules/fiscal/infile/validationChild')

test('XML subprocess inherits only the explicit safe environment, not backend credentials', async () => {
  const previous = process.env.FISCAL_CANARY_TEST_SECRET
  process.env.FISCAL_CANARY_TEST_SECRET = 'SYNTHETIC_NOT_A_CREDENTIAL'
  try {
    const out = await supervise(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'])
    assert.deepEqual(JSON.parse(out), { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' })
  } finally { if (previous === undefined) delete process.env.FISCAL_CANARY_TEST_SECRET; else process.env.FISCAL_CANARY_TEST_SECRET = previous }
})
test('subprocess deadline kills a hung reader with a fixed error', async () => {
  const start = Date.now()
  await assert.rejects(supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), error => error.code === 'FISCAL_XML_TIMEOUT')
  assert.ok(Date.now() - start < 1500)
})
test('output flood is bounded and diagnostic XML never becomes an error message', async () => {
  await assert.rejects(supervise(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxOutput: 1024 }), error => error.code === 'FISCAL_XML_OUTPUT_LIMIT')
  await assert.rejects(supervise(process.execPath, ['-e', 'process.stderr.write("PRIVATE_XML_CANARY");process.exit(1)']), error => error.code === 'FISCAL_XML_INVALID' && !JSON.stringify(error).includes('PRIVATE_XML_CANARY') && !error.message.includes('PRIVATE_XML_CANARY'))
})
test('reader warnings fail closed even when the executable returns success', async () => {
  await assert.rejects(supervise(process.execPath, ['-e', 'process.stderr.write("warning");process.stdout.write("<a/>")']), error => error.code === 'FISCAL_XML_INVALID')
})
test('cancellation and unavailable executables produce controlled errors', async () => {
  const controller = new AbortController()
  const pending = supervise(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.code === 'FISCAL_XML_ABORTED')
  await assert.rejects(supervise('/auna-fiscal-nonexistent-executable', []), error => error.code === 'FISCAL_XML_RUNTIME_UNAVAILABLE')
})
