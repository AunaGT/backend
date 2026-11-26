const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { createRouter } = require('../src/modules/fiscal/routes')
const express = require('express'), http = require('node:http')
test('catalog exposes only implemented Infile and keeps selection separate from emission approval', async () => {
  const scope = { companyId: randomUUID(), actorId: randomUUID(), permissions: ['fiscal.view'] }
  const app = express(); app.use(createRouter({ auth: (_r, _s, next) => next(), scope: () => scope, db: { systemSetting: { findUnique: async ({ where }) => { assert.equal(where.company_id_key.company_id, scope.companyId); return null } } } }))
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/`), body = await r.json()
    assert.equal(r.status, 200); assert.equal(body.selectedProvider, null); assert.equal(body.revision, 0)
    assert.deepEqual(body.providers.map(p => p.id), ['INFILE'])
    assert.equal(body.externalSendingAllowed, false); assert.match(r.headers.get('cache-control'), /no-store/)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
