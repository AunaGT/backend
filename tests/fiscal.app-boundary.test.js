const test = require('node:test'), assert = require('node:assert/strict'), express = require('express'), http = require('node:http'), util = require('node:util')
const { randomUUID } = require('node:crypto')
const { withMocks } = require('./helpers/reportHarness.cjs')
test('app rejects malformed, non-JSON and oversized credential bodies without logging or echoing them', async () => {
  const scope = { companyId: randomUUID(), actorId: randomUUID(), permissions: ['fiscal.manage'] }
  let touched = 0
  const child = require('../src/modules/fiscal/routes').createRouter({ auth: (_r, _s, next) => next(), scope: () => scope, db: { fiscalConnector: { findFirst: async () => { touched++; return null } } } })
  const routes = express.Router(); routes.use('/settings/connectors', child)
  await withMocks({ [require.resolve('../src/routes')]: routes, [require.resolve('../src/modules/users/routes')]: express.Router() }, require.resolve('../app'), async app => {
    const server = http.createServer(app), logs = [], original = console.error
    console.error = (...values) => logs.push(util.inspect(values, { depth: 5 }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${server.address().port}/api/settings/connectors/infile/TEST`
    try {
      const malformed = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"credentials":{"apiKey":"synthetic-private-marker"},' })
      assert.equal(malformed.status, 400)
      assert.equal((await malformed.text()).includes('synthetic-private-marker'), false)
      assert.equal(logs.join('').includes('synthetic-private-marker'), false)
      const huge = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credentials: { apiKey: 'synthetic-private-marker' + 'a'.repeat(40000) } }) })
      assert.equal(huge.status, 413)
      assert.equal((await huge.text()).includes('synthetic-private-marker'), false)
      const encoded = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'apiKey=synthetic-private-marker' })
      assert.equal(encoded.status, 415)
      assert.equal(logs.join('').includes('synthetic-private-marker'), false)
      assert.equal(touched, 0)
      const localProfile = await fetch(`${endpoint}/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 0, idempotencyKey: randomUUID(), profile: { unknown: 'a'.repeat(40000) } }) })
      assert.equal(localProfile.status, 422)
      const hugeProfile = await fetch(`${endpoint}/profile`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: { unknown: 'a'.repeat(140000) } }) })
      assert.equal(hugeProfile.status, 413)
    } finally { console.error = original; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  })
})
