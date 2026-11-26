const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { disposableDatabase, seedLocalTenant } = require('./fixtures/fiscal/database.cjs')
test('exclusive provider selection on disposable PostgreSQL never activates emission or removes configuration', { skip: process.env.AUNA_FISCAL_LOCAL_TESTS !== 'approved', timeout: 60000 }, async () => disposableDatabase(async db => {
  // Use the real revision trigger and audit table definition, not an invented counter.
  const migration = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../prisma/migrations/20261016160000_setting_revisions_audit/migration.sql'), 'utf8')
  await db.$executeRawUnsafe('ALTER TABLE system_settings ADD COLUMN type varchar(50), ADD COLUMN description varchar(255), ADD COLUMN updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await db.$executeRawUnsafe(migration.match(/CREATE TABLE "setting_audit_events"[\s\S]*?\n\);/)[0])
  await db.$executeRawUnsafe(migration.match(/CREATE FUNCTION auna_setting_revision\(\)[\s\S]*?\n\$\$;/)[0])
  await db.$executeRawUnsafe(migration.match(/CREATE TRIGGER auna_setting_revision[\s\S]*?EXECUTE FUNCTION auna_setting_revision\(\);/)[0])
  const f = await seedLocalTenant(db), other = randomUUID(); await db.$executeRaw`INSERT INTO companies(id) VALUES (${other}::uuid)`
  let scope = f.scope
  const express = require('express'), http = require('node:http'), app = express()
  app.use(require('../src/modules/fiscal/routes').createRouter({ ...f.options, db, transactionDb: db, auth: (_r, _s, next) => next(), scope: () => scope }))
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const put = (provider, expectedRevision, extra = {}) => fetch(`${base}/selection`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, expectedRevision, ...extra }) })
  try {
    const versions = await db.fiscalConnectorVersion.findMany()
    assert.equal((await (await fetch(base)).json()).selectedProvider, null)
    const concurrent = await Promise.all([put('INFILE', 0), put('INFILE', 0)])
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409])
    const selected = await (await fetch(base)).json()
    assert.equal(selected.selectedProvider, 'INFILE'); assert.equal(selected.revision, 1); assert.equal(selected.externalSendingAllowed, false)
    assert.equal((await put('INFILE', 1)).status, 200)
    assert.equal(await db.settingAuditEvent.count(), 1)
    for (const extra of [{ approved: true }, { companyId: other }, { environment: 'PRODUCTION' }]) assert.equal((await put(null, 1, extra)).status, 422)
    assert.equal((await put('CUSTOM', 1)).status, 422)
    scope = { ...f.scope, permissions: ['fiscal.view'] }; assert.equal((await put(null, 1)).status, 403)
    scope = f.scope
    assert.equal((await put(null, 1)).status, 200)
    assert.equal((await put('INFILE', 2)).status, 200)
    assert.equal((await put(null, 1)).status, 409)
    assert.equal((await (await fetch(base)).json()).selectedProvider, 'INFILE')
    assert.deepEqual(await db.fiscalConnectorVersion.findMany(), versions)
    assert.equal((await db.fiscalConnector.findFirst()).state, 'DRAFT')
    const audit = await db.settingAuditEvent.findMany({ orderBy: { revision: 'asc' } })
    assert.deepEqual(audit.map(row => row.after_value), ['INFILE', '', 'INFILE'])
    assert.ok(audit.every(row => row.actor_id === scope.actorId && row.source === 'fiscal-provider-selection'))
    scope = { ...f.scope, companyId: other }
    assert.equal((await (await fetch(base)).json()).selectedProvider, null)
    await db.systemSetting.create({ data: { company_id: other, key: 'fiscal.selected_provider', value: 'OTHER', type: 'string' } })
    const replace = await put('INFILE', 1)
    assert.equal(replace.status, 409); assert.equal((await replace.json()).code, 'FISCAL_PROVIDER_ALREADY_SELECTED')
    assert.equal((await put(null, 1)).status, 200)
    assert.equal((await put('INFILE', 2)).status, 200)
    scope = f.scope
    assert.equal((await (await fetch(base)).json()).revision, 3)
    for (const environment of ['TEST', 'PRODUCTION']) {
      const response = await fetch(`${base}/infile/${environment}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(response.status, 403) // no emission permission, regardless of provider selection
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}))
