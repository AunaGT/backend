const test = require('node:test'), assert = require('node:assert/strict')
const { localInput } = require('./fixtures/fiscal/local-input.cjs')
const policy = () => require('../src/modules/fiscal/localPolicy')

test('queue input is local synthetic TEST only and captures an independent canonical snapshot', () => {
  const input = structuredClone(localInput()), result = policy().captureLocalInput(input)
  input.receiver.name = 'changed'
  assert.equal(result.input.receiver.name, 'Consumidor final')
  assert.deepEqual(policy().captureLocalInput(JSON.parse(result.json)), result)
  for (const alter of [i => { i.environment = 'PRODUCTION' }, i => { i.source = 'CONFIRMATION' }, i => { i.externalSendingAllowed = true }, i => { i.credentials = { apiKey: 'not-a-secret' } }, i => { i.profile.credentials = {} }]) {
    const changed = structuredClone(localInput()); alter(changed)
    assert.throws(() => policy().captureLocalInput(changed), error => error.code === 'FISCAL_LOCAL_INPUT_INVALID')
  }
})
test('closed simulator retains the original receipt after response loss and never invents fiscal approval', async () => {
  const { createLocalSimulator, isLocalSimulator } = require('../src/modules/fiscal/localSimulator')
  const simulator = createLocalSimulator({ outcomes: ['LOSE_RESPONSE'] }), envelope = { identifier: 'local-11111111-1111-4111-8111-111111111111', xmlSha256: 'a'.repeat(64), xml: Buffer.from('local') }
  assert.equal(isLocalSimulator({ send() {} }), false); assert.equal(isLocalSimulator(simulator), true)
  await assert.rejects(simulator.send(envelope), error => error.code === 'LOCAL_RESPONSE_LOST')
  const result = await simulator.lookup(envelope)
  assert.equal(result.kind, 'LOCAL_ACCEPTED'); assert.equal(result.certified, false)
  assert.equal(result.xmlSha256, envelope.xmlSha256)
  assert.deepEqual(simulator.stats(), { sends: 1, queries: 1 })
  assert.equal(await simulator.lookup({ ...envelope, xmlSha256: 'b'.repeat(64) }), null)
})
test('worker CLI rejects implicit/shared databases before connecting or loading environment files', () => {
  const { spawnSync } = require('node:child_process'), { resolve } = require('node:path')
  for (const args of [[], ['--local-simulation', '--once']]) {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../scripts/fiscal-worker.js'), ...args], { env: { AUNA_FISCAL_LOCAL_TESTS: 'approved', AUNA_FISCAL_LOCAL_DATABASE_URL: 'postgresql://shared_user:synthetic-canary@example.invalid/shared' }, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 64)
    assert.equal(result.stderr.includes('synthetic-canary'), false)
    assert.equal(result.stdout.includes('loaded from .env'), false)
  }
})
test('dedicated database policy rejects duplicate connection parameters rather than trusting the first host', () => {
  const { localDatabaseUrl } = policy()
  const url = 'postgresql://auna_fiscal_test@localhost:56458/fiscal_11111111111141118111111111111111?host=/tmp/auna-fiscal-pg.fixture/socket'
  for (const extra of ['&host=/tmp/other-socket', '&host=/tmp/auna-fiscal-pg.second/socket', '&connection_limit=1&connection_limit=2']) {
    assert.throws(() => localDatabaseUrl({ AUNA_FISCAL_LOCAL_TESTS: 'approved', AUNA_FISCAL_LOCAL_DATABASE_URL: url + extra }), error => error.code === 'FISCAL_LOCAL_DATABASE_REQUIRED')
  }
})
test('queue preserves actual Carta and 80mm rendering profiles with fractional layout values', () => {
  const { resolveBase, freezeProfile } = require('../src/modules/config/documentTemplates/presets')
  const input = structuredClone(localInput())
  const design = resolveBase('CLASSIC', 'LETTER', 'FEL_INVOICE'); design.paper.margin = 36.5
  input.renderProfiles = {
    LETTER: freezeProfile(design, { fontSize: 10.5 }),
    RECEIPT_80: freezeProfile(resolveBase('CLASSIC', 'RECEIPT_80', 'INTERNAL_RECEIPT')),
  }
  assert.deepEqual(policy().captureLocalInput(input).input.renderProfiles, input.renderProfiles)
  for (const number of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => policy().canonicalJson({ number }))
  const invalid = structuredClone(input); invalid.lines[0].unitPrice = 12.5
  assert.throws(() => policy().captureLocalInput(invalid), error => error.code === 'FISCAL_LOCAL_INPUT_INVALID')
})
test('worker launch drops inherited secrets and denies environment-file reads at runtime', () => {
  const { workerLaunch } = require('../scripts/fiscal-worker-launch')
  const { spawnSync } = require('node:child_process'), { resolve } = require('node:path')
  const launch = workerLaunch({ AUNA_FISCAL_LOCAL_TESTS: 'approved', AUNA_FISCAL_LOCAL_DATABASE_URL: 'postgresql://auna_fiscal_test@localhost:56458/fiscal_11111111111141118111111111111111?host=/tmp/auna-fiscal-pg.fixture/socket', DATABASE_URL: 'synthetic-shared-canary', FISCAL_ENCRYPTION_KEYS_JSON: 'synthetic-key-canary', NODE_OPTIONS: '--bad-option' }, ['--local-simulation', '--once'])
  const runtime = launch.args.indexOf(resolve(__dirname, '../scripts/fiscal-worker-runtime.js'))
  const probe = `const fs=require('node:fs');let code;try{fs.readFileSync(${JSON.stringify(resolve(__dirname, '../.env'))})}catch(e){code=e.code}console.log(JSON.stringify({code,keys:Object.keys(process.env).sort()}))`
  const result = spawnSync(process.execPath, [...launch.args.slice(0, runtime), '-e', probe], { ...launch.options, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { code: 'ERR_ACCESS_DENIED', keys: Object.keys(launch.options.env).sort() })
  for (const key of ['DATABASE_URL', 'FISCAL_ENCRYPTION_KEYS_JSON', 'NODE_OPTIONS']) assert.equal(key in launch.options.env, false)
  const direct = spawnSync(process.execPath, [resolve(__dirname, '../scripts/fiscal-worker-runtime.js')], { encoding: 'utf8', timeout: 5000 })
  assert.equal(direct.status, 64)
})
