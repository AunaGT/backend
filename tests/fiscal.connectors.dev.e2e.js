const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { PrismaClient } = require('@prisma/client')
const service = require('../src/modules/fiscal/connectorService')
const { openCredentials, readKeyring } = require('../src/modules/fiscal/credentials')

test('offline connection persistence on disposable local PostgreSQL', {
  skip: process.env.AUNA_FISCAL_LOCAL_TESTS !== 'approved', timeout: 60000,
}, async t => {
  const url = require('../src/modules/fiscal/localPolicy').localDatabaseLocation(process.env)
  assert.equal(url.pathname, '/postgres')
  const database = `fiscal_${randomUUID().replaceAll('-', '')}`
  execFileSync('psql', [url.href, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database}`], { stdio: 'pipe' })
  const adminUrl = url.href
  url.pathname = `/${database}`
  const db = new PrismaClient({ datasources: { db: { url: url.href } } })
  const keyEnv = { FISCAL_ACTIVE_KEY_ID: 'local-only', FISCAL_ENCRYPTION_KEYS_JSON: JSON.stringify({ 'local-only': Buffer.alloc(32, 17).toString('base64') }) }
  const options = { keyring: () => readKeyring(keyEnv) }
  const scope = { companyId: randomUUID(), actorId: randomUUID(), permissions: ['fiscal.manage', 'fiscal.test', 'fiscal.view'] }
  const credentials = { signUser: 'local-user-sign', signKey: 'local-secret-sign', apiUser: 'local-user-api', apiKey: 'local-secret-api' }
  try {
    for (const file of ['tests/fixtures/fiscal/bootstrap-local.sql', 'prisma/migrations/20261023210000_fiscal_connections/migration.sql', 'prisma/migrations/20261023220000_fiscal_preparation/migration.sql', 'prisma/migrations/20261023230000_fiscal_local_queue/migration.sql', 'prisma/migrations/20261023235000_fiscal_proposed_endpoints/migration.sql']) {
      execFileSync('psql', [url.href, '-v', 'ON_ERROR_STOP=1', '-f', path.resolve(__dirname, '..', file)], { stdio: 'pipe' })
    }
    await db.$executeRaw`INSERT INTO companies (id) VALUES (${scope.companyId}::uuid)`
    let created
    const initial = { environment: 'TEST', expectedVersion: 0, idempotencyKey: randomUUID(), credentials }
    await t.test('concurrent retries create one encrypted version and no plaintext response', async () => {
      const results = await Promise.all([service.saveInfileConnection(db, scope, initial, options), service.saveInfileConnection(db, scope, initial, options)])
      created = results[0]
      assert.deepEqual(results[1], created)
      assert.equal(created.state, 'DRAFT')
      assert.equal(created.capabilities.externalSendingAllowed, false)
      assert.equal(await db.fiscalConnector.count(), 1)
      assert.equal(await db.fiscalConnectorVersion.count(), 1)
      assert.equal(await db.fiscalEvent.count(), 1)
      const version = await db.fiscalConnectorVersion.findFirst()
      assert.deepEqual(openCredentials({ companyId: scope.companyId, connectorId: created.id, environment: 'TEST', credentialVersion: version.number }, version.credentials, options.keyring()), credentials)
      for (const value of Object.values(credentials)) {
        assert.equal(JSON.stringify(created).includes(value), false)
        assert.equal(JSON.stringify(await db.fiscalEvent.findMany()).includes(value), false)
        assert.equal(JSON.stringify(version).includes(value), false)
      }
    })
    await t.test('stale writes and changed-payload retries cannot overwrite credentials', async () => {
      await assert.rejects(service.saveInfileConnection(db, scope, { ...initial, idempotencyKey: randomUUID() }, options), error => error.status === 409)
      await assert.rejects(service.saveInfileConnection(db, scope, { ...initial, credentials: { ...credentials, apiKey: 'different-secret' } }, options), error => error.code === 'FISCAL_IDEMPOTENCY_CONFLICT')
      assert.equal(await db.fiscalConnectorVersion.count(), 1)
    })
    await t.test('partial rotation preserves other fields and creates an immutable version', async () => {
      const updated = await service.saveInfileConnection(db, scope, { environment: 'TEST', expectedVersion: created.revision, idempotencyKey: randomUUID(), credentials: { apiKey: 'new-local-api-secret' } }, options)
      assert.equal(updated.revision, 2)
      const version = await db.fiscalConnectorVersion.findFirst({ orderBy: { number: 'desc' } })
      assert.deepEqual(openCredentials({ companyId: scope.companyId, connectorId: created.id, environment: 'TEST', credentialVersion: version.number }, version.credentials, options.keyring()), { ...credentials, apiKey: 'new-local-api-secret' })
      await assert.rejects(db.fiscalConnectorVersion.update({ where: { id: version.id }, data: { number: 3 } }))
      const event = await db.fiscalEvent.findFirst()
      await assert.rejects(db.fiscalEvent.delete({ where: { id: event.id } }))
    })
    await t.test('scope and payload checks reject cross-tenant or approval writes', async () => {
      await assert.rejects(service.readInfileConnection(db, { ...scope, permissions: [] }, 'TEST', options), error => error.status === 403)
      const other = await service.readInfileConnection(db, { ...scope, companyId: randomUUID() }, 'TEST', options)
      assert.equal(other.id, null)
      assert.equal(other.revision, 0)
      await assert.rejects(service.saveInfileConnection(db, scope, { ...initial, state: 'PRODUCTION_READY' }, options), error => error.status === 422)
      await assert.rejects(service.saveInfileConnection(db, scope, { ...initial, credentials: { apiKey: '' } }, options), error => error.status === 422)
      assert.equal(await db.fiscalConnector.count(), 1)
    })
    await t.test('local review never claims valid external credentials or approval', async () => {
      const result = await service.validateConnectionLocally(db, scope, { environment: 'TEST', expectedVersion: 2, idempotencyKey: randomUUID() }, options)
      assert.equal(result.kind, 'LOCAL_ONLY')
      assert.equal(result.externalContact, false)
      assert.equal(result.credentialsVerified, false)
      assert.equal(result.productionReady, false)
      assert.equal((await db.fiscalConnector.findFirst()).state, 'DRAFT')
    })
    await t.test('anonymous/client roles cannot read private tables and cross-company versions fail', async () => {
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(db.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
          await tx.$queryRaw`SELECT credentials FROM fiscal_connector_versions`
        }))
      }
      await assert.rejects(db.fiscalConnectorVersion.create({ data: { company_id: randomUUID(), connector_id: created.id, environment: 'TEST', number: 99, credentials: {}, created_by: scope.actorId } }))
      await assert.rejects(db.fiscalConnector.delete({ where: { id: created.id } }))
    })
    await t.test('real HTTP router persists through the scoped service without external contact', async () => {
      const http = require('node:http'), express = require('express')
      const app = express()
      app.use(require('../src/modules/fiscal/routes').createRouter({ ...options, db, transactionDb: db, auth: (_r, _s, next) => next(), scope: () => scope }))
      const server = http.createServer(app)
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const endpoint = `http://127.0.0.1:${server.address().port}`
      try {
        const read = await fetch(`${endpoint}/infile/TEST`)
        assert.equal(read.status, 200); assert.equal((await read.json()).revision, 2)
        const local = await fetch(`${endpoint}/infile/TEST/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: 2, idempotencyKey: randomUUID() }) })
        assert.equal(local.status, 200); assert.equal((await local.json()).externalContact, false)
        const history = await fetch(`${endpoint}/infile/TEST/history`)
        assert.equal(history.status, 200); assert.equal((await history.json()).length, 4)
        const eventCount = await db.fiscalEvent.count()
        const blocked = await fetch(`${endpoint}/infile/TEST/tests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        assert.equal(blocked.status, 409); assert.equal(await db.fiscalEvent.count(), eventCount)
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    })
    await t.test('action URLs version independently of credentials, preserve history and never enable external transport', async () => {
      const localScope = { ...scope, companyId: randomUUID() }
      await db.$executeRaw`INSERT INTO companies(id) VALUES (${localScope.companyId}::uuid)`
      const command = { environment: 'TEST', expectedVersion: 0, idempotencyKey: randomUUID(), endpoints: { ISSUE: 'https://provider.example.invalid/issue', LOOKUP: 'https://provider.example.invalid/lookup' } }
      const first = await service.saveInfileConnection(db, localScope, command, options)
      assert.equal(first.revision, 1); assert.equal(first.credentialStatus.apiKey, false)
      assert.equal(first.endpoints.ISSUE, 'https://provider.example.invalid/issue')
      assert.equal(first.endpoints.CANCEL, null); assert.equal(first.capabilities.externalSendingAllowed, false)
      assert.deepEqual(await service.saveInfileConnection(db, localScope, command, options), first)
      const prior = await db.fiscalConnectorVersion.findFirst({ where: { connector_id: first.id } })
      await db.fiscalConnector.update({ where: { id: first.id }, data: { state: 'PRODUCTION_READY' } })
      const changed = await service.saveInfileConnection(db, localScope, { ...command, expectedVersion: 1, idempotencyKey: randomUUID(), endpoints: { ISSUE: 'https://provider.example.invalid/new-issue', LOOKUP: null } }, options)
      assert.equal(changed.revision, 2); assert.equal(changed.endpoints.LOOKUP, null)
      assert.equal(changed.state, 'DRAFT'); assert.equal(changed.capabilities.productionReady, false)
      assert.deepEqual((await db.fiscalConnectorVersion.findUnique({ where: { id: prior.id } })).endpoints, { ISSUE: 'https://provider.example.invalid/issue', LOOKUP: 'https://provider.example.invalid/lookup' })
      const cleared = await service.saveInfileConnection(db, localScope, { environment: 'TEST', expectedVersion: 2, idempotencyKey: randomUUID(), endpoints: { ISSUE: null } }, options)
      assert.equal(cleared.endpoints.ISSUE, null); assert.equal(cleared.credentialStatus.apiKey, false)
      const rotated = await service.saveInfileConnection(db, localScope, { environment: 'TEST', expectedVersion: 3, idempotencyKey: randomUUID(), credentials }, options)
      assert.deepEqual(rotated.endpoints, cleared.endpoints)
      assert.equal((await service.readInfileConnection(db, localScope, 'PRODUCTION', options)).endpoints.ISSUE, null)
      assert.equal((await service.readInfileConnection(db, scope, 'TEST', options)).endpoints.ISSUE, null)
      await assert.rejects(service.saveInfileConnection(db, { ...localScope, permissions: ['fiscal.view'] }, command, options), error => error.status === 403)
      await assert.rejects(service.saveInfileConnection(db, localScope, { ...command, idempotencyKey: randomUUID() }, options), error => error.code === 'FISCAL_STALE_VERSION')
      await assert.rejects(service.saveInfileConnection(db, localScope, { ...command, endpoints: { ISSUE: 'https://provider.example.invalid/changed' } }, options), error => error.code === 'FISCAL_IDEMPOTENCY_CONFLICT')
      const latest = await db.fiscalConnectorVersion.findFirst({ where: { connector_id: first.id }, orderBy: { number: 'desc' } })
      await assert.rejects(db.fiscalConnectorVersion.update({ where: { id: prior.id }, data: { endpoints: {} } }))
      for (const endpoints of [{ UNKNOWN: 'https://provider.example.invalid/' }, { ISSUE: null }, []]) await assert.rejects(db.fiscalConnectorVersion.create({ data: { company_id: localScope.companyId, connector_id: first.id, environment: 'TEST', number: 99, created_by: localScope.actorId, endpoints } }))
      assert.equal(latest.number, 4)
    })
    await t.test('profile-only setup versions issuer and establishments before provider credentials exist', async () => {
      const { fixture } = require('./fixtures/fiscal/preparation.cjs'), f = fixture()
      await db.$executeRaw`INSERT INTO companies(id) VALUES (${f.ids.company}::uuid)`
      await db.$executeRaw`INSERT INTO branches(id, company_id, name) VALUES (${f.ids.branch}::uuid, ${f.ids.company}::uuid, 'Sucursal ficticia')`
      await db.$executeRaw`INSERT INTO product_categories(id, company_id, name) VALUES (10, ${f.ids.company}::uuid, 'Categoría ficticia')`
      await db.$executeRaw`INSERT INTO products(id, company_id, category_id, name) VALUES (${f.ids.product}::uuid, ${f.ids.company}::uuid, 10, 'Producto ficticio')`
      await db.$executeRaw`INSERT INTO measure_units(id, company_id, name) VALUES (${f.ids.unit}::uuid, ${f.ids.company}::uuid, 'Unidad ficticia')`
      await db.$executeRaw`INSERT INTO product_presentations(id, company_id, product_id, name) VALUES (${f.ids.presentation}::uuid, ${f.ids.company}::uuid, ${f.ids.product}::uuid, 'Presentación ficticia')`
      for (const row of f.settings) await db.$executeRaw`INSERT INTO system_settings(company_id, key, value) VALUES (${f.ids.company}::uuid, ${row.key}, ${row.value})`
      const expectedIssuerFingerprint = require('../src/modules/fiscal/profiles').issuerFromSettings(f.settings).settingsFingerprint
      const input = { environment: 'TEST', expectedVersion: 0, idempotencyKey: randomUUID(), expectedIssuerFingerprint, profile: f.draft }
      const [saved, retried] = await Promise.all([service.saveFiscalProfile(db, f.scope, input, options), service.saveFiscalProfile(db, f.scope, input, options)])
      assert.deepEqual(retried, saved); assert.equal(saved.revision, 1)
      const connection = await service.readInfileConnection(db, f.scope, 'TEST', options)
      assert.equal(connection.credentialStatus.apiKey, false)
      const prepared = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.equal(prepared.profile.establishments[0].code, '001'); assert.equal(prepared.profile.emitter.legalName, 'Emisor ficticio, S.A.')
      assert.equal(prepared.readiness.valid, true); assert.equal(prepared.readiness.productionReady, false)
      const oldId = prepared.versionId
      await service.saveInfileConnection(db, f.scope, { environment: 'TEST', expectedVersion: 1, idempotencyKey: randomUUID(), credentials }, options)
      const next = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.equal(next.revision, 2); assert.deepEqual(next.profile, prepared.profile)
      assert.equal(await db.fiscalEstablishment.count({ where: { company_id: f.ids.company } }), 2)
      await assert.rejects(service.saveFiscalProfile(db, f.scope, { ...input, idempotencyKey: randomUUID() }, options), error => error.code === 'FISCAL_STALE_VERSION')
      await assert.rejects(service.saveFiscalProfile(db, f.scope, { ...input, expectedVersion: 2, idempotencyKey: randomUUID(), profile: { ...f.draft, establishments: [{ ...f.draft.establishments[0], branchId: scope.companyId }] } }, options), error => error.code === 'FISCAL_PROFILE_REFERENCE_INVALID')
      await db.$executeRaw`UPDATE system_settings SET value = 'Emisor cambiado', revision = 2 WHERE company_id = ${f.ids.company}::uuid AND key = 'company_legal_name'`
      const stale = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.equal(stale.profile.emitter.legalName, 'Emisor ficticio, S.A.'); assert.equal(stale.readiness.valid, false)
      assert.ok(stale.readiness.fieldErrors['emitter.changed'])
      await assert.rejects(service.saveFiscalProfile(db, f.scope, { ...input, expectedVersion: 2, idempotencyKey: randomUUID() }, options), error => error.code === 'FISCAL_ISSUER_CHANGED')
      await service.saveFiscalProfile(db, f.scope, { ...input, expectedVersion: 2, expectedIssuerFingerprint: stale.currentIssuer.settingsFingerprint, idempotencyKey: randomUUID() }, options)
      assert.equal((await service.readFiscalProfile(db, f.scope, 'TEST')).profile.emitter.legalName, 'Emisor cambiado')
      await service.saveInfileConnection(db, f.scope, { environment: 'TEST', expectedVersion: 3, idempotencyKey: randomUUID(), endpoints: { CREDIT_NOTE: 'https://provider.example.invalid/issue' } }, options)
      await service.saveFiscalProfile(db, f.scope, { ...input, expectedVersion: 4, expectedIssuerFingerprint: stale.currentIssuer.settingsFingerprint, idempotencyKey: randomUUID() }, options)
      const preserved = await service.readInfileConnection(db, f.scope, 'TEST', options)
      assert.equal(preserved.endpoints.CREDIT_NOTE, 'https://provider.example.invalid/issue')
      assert.equal(preserved.credentialStatus.apiKey, true)
      const original = await db.fiscalConnectorVersion.findFirst({ where: { id: oldId } })
      assert.equal(original.profile.emitter.legalName, 'Emisor ficticio, S.A.')
      const row = await db.fiscalEstablishment.findFirst({ where: { company_id: f.ids.company } })
      await assert.rejects(db.fiscalEstablishment.update({ where: { id: row.id }, data: { data: {} } }))
      for (const role of ['anon', 'authenticated']) await assert.rejects(db.$transaction(async tx => { await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`); await tx.fiscalEstablishment.findMany() }))
      const foreign = await service.readFiscalProfile(db, { ...f.scope, companyId: randomUUID() }, 'TEST')
      assert.equal(foreign.profile, null)
      const catalog = await service.profileOptions(db, f.scope, { kind: 'branch', page: '1', query: '' })
      assert.equal(catalog.total, 1); assert.equal(catalog.rows[0].id, f.ids.branch)
      const events = await db.fiscalEvent.findMany({ where: { company_id: f.ids.company } })
      assert.equal(JSON.stringify(events).includes('Emisor ficticio'), false)
      for (const value of Object.values(credentials)) assert.equal(JSON.stringify(events).includes(value), false)
    })
    await t.test('company rate changes require explicit refresh and preserve both tax history and environment isolation', async () => {
      const { fixture } = require('./fixtures/fiscal/preparation.cjs'), f = fixture()
      const prior = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.equal(prior.profile.taxConfiguration.ivaRate, '0.12')
      await db.$executeRaw`UPDATE system_settings SET value = '10', revision = revision + 1 WHERE company_id = ${f.ids.company}::uuid AND key = 'iva_rate'`
      const changed = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.equal(changed.profile.taxConfiguration.ivaRate, '0.12')
      assert.equal(changed.currentIssuer.taxConfiguration.ivaRate, '0.1')
      assert.equal(changed.readiness.valid, false)
      assert.ok(changed.readiness.fieldErrors['emitter.changed'])
      const input = { environment: 'TEST', expectedVersion: prior.revision, idempotencyKey: randomUUID(), expectedIssuerFingerprint: prior.currentIssuer.settingsFingerprint, profile: f.draft }
      await assert.rejects(service.saveFiscalProfile(db, f.scope, input, options), error => error.code === 'FISCAL_ISSUER_CHANGED')
      const updatedDraft = { ...f.draft, taxRules: [{ ...f.draft.taxRules[0], rate: '0.1' }] }
      await service.saveFiscalProfile(db, f.scope, { ...input, idempotencyKey: randomUUID(), expectedIssuerFingerprint: changed.currentIssuer.settingsFingerprint, profile: updatedDraft }, options)
      const refreshed = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.equal(refreshed.profile.taxConfiguration.ivaRate, '0.1')
      assert.equal(refreshed.readiness.valid, true)
      const old = await db.fiscalConnectorVersion.findUnique({ where: { id: prior.versionId } })
      assert.equal(old.profile.taxConfiguration.ivaRate, '0.12')
      assert.equal((await service.readFiscalProfile(db, f.scope, 'PRODUCTION')).profile, null)
      assert.equal((await service.readFiscalProfile(db, scope, 'TEST')).currentIssuer.taxConfiguration.ivaRate, null)
      await db.$executeRaw`UPDATE system_settings SET value = '12', revision = revision + 1 WHERE company_id = ${f.ids.company}::uuid AND key = 'iva_rate'`
      const restoredValue = await service.readFiscalProfile(db, f.scope, 'TEST')
      assert.notEqual(restoredValue.currentIssuer.settingsFingerprint, prior.currentIssuer.settingsFingerprint)
      assert.equal(restoredValue.readiness.valid, false)
    })
  } finally {
    await db.$disconnect()
    execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${database}`], { stdio: 'pipe' })
  }
})
