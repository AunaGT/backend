const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), express = require('express')
const { randomUUID } = require('node:crypto')
const { createRouter } = require('../src/modules/fiscal/routes')
test('fiscal routes keep the offline boundary, tenant scope and errors private', async () => {
  const scope = { companyId: randomUUID(), actorId: randomUUID(), permissions: ['fiscal.manage', 'fiscal.test', 'fiscal.activate'] }
  let calls = 0, company
  const db = { fiscalConnector: { findFirst: async query => { calls++; company = query.where.company_id; return null } } }
  const app = express()
  app.use(createRouter({ db, transactionDb: db, auth: (_r, _s, next) => next(), scope: () => scope }))
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  const call = (path, body, method = 'POST') => fetch(endpoint + path, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const read = await call('/infile/TEST'); assert.equal(read.status, 200); assert.equal(company, scope.companyId)
    assert.match(read.headers.get('cache-control'), /no-store/)
    const data = await read.json(); assert.equal(data.capabilities.externalSendingAllowed, false)
    assert.deepEqual(data.endpoints, { ISSUE: null, CREDIT_NOTE: null, CANCEL: null, LOOKUP: null })
    const invalidUrl = await call('/infile/TEST', { expectedVersion: 0, idempotencyKey: randomUUID(), endpoints: { ISSUE: 'https://user:synthetic-secret@provider.example.invalid/' } }, 'PUT')
    assert.equal(invalidUrl.status, 422)
    const invalidData = await invalidUrl.json()
    assert.ok(invalidData.fields['endpoints.ISSUE']); assert.equal(JSON.stringify(invalidData).includes('synthetic-secret'), false)
    for (const action of ['tests', 'activate']) {
      const response = await call(`/infile/PRODUCTION/${action}`, { approved: true, endpoint: 'https://example.invalid' })
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'FISCAL_EXTERNAL_DISABLED')
    }
    assert.equal(calls, 1)
    const bad = await call('/infile/TEST', { environment: 'PRODUCTION', expectedVersion: 0, idempotencyKey: randomUUID() }, 'PUT')
    assert.equal(bad.status, 422)
    const unknown = await call('/infile/live'); assert.equal(unknown.status, 422)
    scope.permissions = []
    assert.equal((await call('/infile/TEST')).status, 403)
    scope.permissions = ['fiscal.view']
    db.fiscalConnector.findFirst = async () => { throw Object.assign(new Error('private-password-in-database-error'), { code: 'P2021' }) }
    const unavailable = await call('/infile/TEST'); assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.text()).includes('private-password'), false)
    db.fiscalConnector.findFirst = async () => { throw new Error('private-password-in-database-error') }
    const unexpected = await call('/infile/TEST'); assert.equal(unexpected.status, 500)
    assert.equal((await unexpected.text()).includes('private-password'), false)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
