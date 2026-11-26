const test = require('node:test')
const assert = require('node:assert/strict')
const { contractFor } = require('../src/modules/fiscal/infile/contract')
const { sendInfile } = require('../src/modules/fiscal/infile/transport')

test('even production flags and caller-supplied approval cannot enable Infile traffic', async () => {
  let calls = 0
  const previous = process.env.FISCAL_ALLOW_PRODUCTION
  process.env.FISCAL_ALLOW_PRODUCTION = 'true'
  try {
    for (const environment of ['TEST', 'PRODUCTION']) {
      const contract = contractFor(environment, { verified: true, endpoint: 'https://example.invalid', approved: true })
      assert.equal(contract.verified, false)
      assert.equal(contract.endpoint, null)
      assert.equal(contract.externalSendingAllowed, false)
      await assert.rejects(sendInfile({ contract, credentials: { signKey: 'never-log-this' }, fetch: () => { calls++; throw Error('unexpected network') } }), error => error.code === 'FISCAL_EXTERNAL_DISABLED' && !error.message.includes('never-log-this'))
    }
    await assert.rejects(sendInfile({ contract: { verified: true, externalSendingAllowed: true } }), error => error.code === 'FISCAL_EXTERNAL_DISABLED')
    assert.equal(calls, 0)
  } finally {
    if (previous === undefined) delete process.env.FISCAL_ALLOW_PRODUCTION
    else process.env.FISCAL_ALLOW_PRODUCTION = previous
  }
})

test('invalid environments are rejected instead of falling back to production', () => {
  for (const environment of ['sandbox', 'test', '', null, undefined, 'LIVE']) {
    assert.throws(() => contractFor(environment), error => error.status === 422)
  }
})
