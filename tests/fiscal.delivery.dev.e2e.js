const test = require('node:test'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { disposableDatabase, seedLocalTenant } = require('./fixtures/fiscal/database.cjs')

test('durable local fiscal queue on disposable PostgreSQL', { skip: process.env.AUNA_FISCAL_LOCAL_TESTS !== 'approved', timeout: 60000 }, async t => {
  await disposableDatabase(async (db, database) => {
    const { enqueueFiscalOperation, readFiscalOperation } = require('../src/modules/fiscal/operations')
    const { processNextFiscalOperation, claimNextOperation, beginSending, finishSending } = require('../src/modules/fiscal/worker')
    const { reconcileFiscalOperation } = require('../src/modules/fiscal/reconciliation')
    const { createLocalSimulator } = require('../src/modules/fiscal/localSimulator')
    const { buildLocalIssueXml } = require('../src/modules/fiscal/infile/xml')
    const { createHash } = require('node:crypto')
    const tenant = await seedLocalTenant(db), { scope, options } = tenant
    const { resolveBase, freezeProfile } = require('../src/modules/config/documentTemplates/presets')
    tenant.input.renderProfiles = { LETTER: freezeProfile(resolveBase('CLASSIC', 'LETTER', 'FEL_INVOICE'), { fontSize: 10.5 }), RECEIPT_80: freezeProfile(resolveBase('CLASSIC', 'RECEIPT_80', 'INTERNAL_RECEIPT')) }
    const enqueue = command => enqueueFiscalOperation(db, scope, command || tenant.command(), options)
    const simulator = createLocalSimulator()
    const work = () => processNextFiscalOperation(db, { workerId: 'local-test-worker', simulator })
    const row = id => db.fiscalOperation.findUnique({ where: { id } })

    await t.test('concurrent idempotency and source keys create one operation, including outer rollback', async () => {
      const command = tenant.command(), [a, b] = await Promise.all([enqueue(command), enqueue(command)])
      assert.deepEqual(a, b); assert.equal(a.simulationOnly, true); assert.equal(a.certified, false)
      assert.equal((await enqueue({ ...command, idempotencyKey: randomUUID() })).id, a.id)
      assert.equal(await db.fiscalOperation.count(), 1)
      await assert.rejects(enqueue({ ...command, sourceKey: randomUUID() }), error => error.status === 409)
      const changed = structuredClone(command); changed.idempotencyKey = randomUUID(); changed.input.receiver.name = 'changed'
      await assert.rejects(enqueue(changed), error => error.code === 'FISCAL_SOURCE_CONFLICT')
      await assert.rejects(db.$transaction(async tx => { await enqueueFiscalOperation(tx, scope, tenant.command(), options); throw Error('rollback') }))
      assert.equal(await db.fiscalOperation.count(), 1)
      assert.equal(await work(), 'accepted')
      const accepted = await row(a.id)
      assert.equal(accepted.state, 'ACCEPTED'); assert.ok(accepted.accepted_attempt_id); assert.equal(accepted.result, null)
      assert.equal(await work(), 'done'); assert.equal((await row(a.id)).state, 'DONE')
      assert.equal(simulator.stats().sends, 1)
    })
    await t.test('response loss is UNKNOWN, never automatically resent, and lookup recovers the same receipt', async () => {
      const lost = createLocalSimulator({ outcomes: ['LOSE_RESPONSE'] }), operation = await enqueue()
      assert.equal(await processNextFiscalOperation(db, { workerId: 'lost', simulator: lost }), 'unknown')
      assert.equal((await row(operation.id)).state, 'UNKNOWN')
      assert.equal(await processNextFiscalOperation(db, { workerId: 'lost-again', simulator: lost }), 'idle')
      const pending = await row(operation.id), command = { expectedVersion: pending.revision, idempotencyKey: randomUUID() }
      const recovered = await reconcileFiscalOperation(db, scope, operation.id, command, { ...options, simulator: lost })
      assert.equal(recovered.state, 'ACCEPTED'); assert.equal(recovered.certified, false)
      assert.deepEqual(await reconcileFiscalOperation(db, scope, operation.id, command, { ...options, simulator: lost }), recovered)
      assert.equal(await processNextFiscalOperation(db, { workerId: 'local-materialize', simulator: lost }), 'done')
      assert.deepEqual(lost.stats(), { sends: 1, queries: 1 })
      assert.equal((await row(operation.id)).identifier, pending.identifier)
    })
    await t.test('crash after sending expires to UNKNOWN and a stale lease cannot commit', async () => {
      const operation = await enqueue(), job = await claimNextOperation(db, { workerId: 'crash' })
      const xml = buildLocalIssueXml(job.snapshot), sha256 = createHash('sha256').update(xml).digest('hex')
      const started = await beginSending(db, job, { xml, sha256 })
      const outcome = await simulator.send({ identifier: started.identifier, xmlSha256: sha256, xml })
      const durable = await row(operation.id)
      assert.deepEqual(Buffer.from(durable.xml_bytes), xml); assert.equal(durable.xml_sha256, sha256)
      await db.$executeRaw`UPDATE fiscal_operations SET lease_until = CURRENT_TIMESTAMP - interval '1 second' WHERE id = ${operation.id}::uuid`
      assert.equal(await work(), 'idle')
      assert.equal((await row(operation.id)).state, 'UNKNOWN')
      assert.equal(await finishSending(db, started, outcome), false)
      const current = await row(operation.id)
      await reconcileFiscalOperation(db, scope, operation.id, { expectedVersion: current.revision, idempotencyKey: randomUUID() }, { ...options, simulator })
      assert.equal(await work(), 'done')
    })
    await t.test('two workers cannot claim the same connector and the global active limit is two', async () => {
      const other = await seedLocalTenant(db), third = await seedLocalTenant(db)
      for (const item of [tenant, tenant, other, third]) await enqueueFiscalOperation(db, item.scope, item.command(), item.options)
      const claims = await Promise.all(['a', 'b', 'c'].map(workerId => claimNextOperation(db, { workerId })))
      assert.equal(claims.filter(Boolean).length, 2)
      assert.equal(new Set(claims.filter(Boolean).map(r => r.connector_id)).size, 2)
      await db.$executeRaw`UPDATE fiscal_operations SET lease_until = CURRENT_TIMESTAMP - interval '1 second' WHERE lease_token IS NOT NULL`
      for (let i = 0; i < 8; i++) await work()
      assert.equal(await db.fiscalOperation.count({ where: { state: { in: ['QUEUED', 'ACCEPTED'] } } }), 0)
    })
    await t.test('rotation or pause blocks unsent context, but accepted inbox survives pause and materialization failure', async () => {
      const operation = await enqueue()
      await db.fiscalConnector.update({ where: { id: (await db.fiscalConnector.findFirst({ where: { company_id: scope.companyId } })).id }, data: { state: 'PAUSED' } })
      assert.equal(await work(), 'blocked'); assert.equal((await row(operation.id)).state, 'BLOCKED')
      const connector = await db.fiscalConnector.findFirst({ where: { company_id: scope.companyId } })
      await db.fiscalConnector.update({ where: { id: connector.id }, data: { state: 'DRAFT' } })
      const accepted = await enqueue(); assert.equal(await work(), 'accepted')
      await db.fiscalConnector.update({ where: { id: connector.id }, data: { state: 'PAUSED' } })
      await db.$executeRawUnsafe("CREATE FUNCTION fail_local_materialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='DONE' THEN RAISE EXCEPTION 'synthetic storage failure'; END IF; RETURN NEW; END $$")
      await db.$executeRawUnsafe('CREATE TRIGGER synthetic_storage_failure BEFORE UPDATE ON fiscal_operations FOR EACH ROW EXECUTE FUNCTION fail_local_materialization()')
      const sent = simulator.stats().sends
      assert.equal(await work(), 'retry')
      assert.equal((await row(accepted.id)).state, 'ACCEPTED')
      assert.equal(await work(), 'idle')
      await db.$executeRawUnsafe('DROP TRIGGER synthetic_storage_failure ON fiscal_operations')
      await db.$executeRaw`UPDATE fiscal_operations SET available_at = CURRENT_TIMESTAMP - interval '1 second' WHERE id = ${accepted.id}::uuid`
      assert.equal(await work(), 'done'); assert.equal(simulator.stats().sends, sent)
    })
    await t.test('tenant boundaries, append-only evidence and private XML cannot be bypassed', async () => {
      const existing = await db.fiscalOperation.findFirst({ where: { company_id: scope.companyId, state: 'DONE' } })
      await assert.rejects(readFiscalOperation(db, { ...scope, branchId: randomUUID() }, existing.id), error => error.status === 404)
      await assert.rejects(readFiscalOperation(db, { ...scope, permissions: [] }, existing.id), error => error.status === 403)
      await assert.rejects(db.fiscalOperation.update({ where: { id: existing.id }, data: { snapshot: {} } }))
      await assert.rejects(db.fiscalOperation.update({ where: { id: existing.id }, data: { xml_bytes: Buffer.from('changed') } }))
      const attempt = await db.fiscalAttempt.findFirst()
      await assert.rejects(db.fiscalAttempt.update({ where: { id: attempt.id }, data: { inbox: { changed: true } } }))
      await assert.rejects(db.fiscalOperation.delete({ where: { id: existing.id } }))
      for (const role of ['anon', 'authenticated']) await assert.rejects(db.$transaction(async tx => { await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`); await tx.$queryRaw`SELECT xml_bytes FROM fiscal_operations` }))
      const events = JSON.stringify(await db.fiscalEvent.findMany({ where: { action: { startsWith: 'LOCAL_' } } }))
      assert.equal(events.includes('Consumidor final'), false); assert.equal(events.includes('FiscalDraft'), false)
      assert.deepEqual(existing.snapshot.renderProfiles, tenant.input.renderProfiles)
    })
    await t.test('a rotated version blocks an unsent job without borrowing the new configuration', async () => {
      const rotated = await seedLocalTenant(db), operation = await enqueueFiscalOperation(db, rotated.scope, rotated.command(), rotated.options)
      const prior = await db.fiscalConnectorVersion.findUnique({ where: { id: rotated.input.connectorVersionId } })
      await db.fiscalConnectorVersion.create({ data: { company_id: prior.company_id, connector_id: prior.connector_id, environment: 'TEST', number: 2, profile: prior.profile, created_by: rotated.scope.actorId } })
      await db.fiscalConnector.update({ where: { id: prior.connector_id }, data: { revision: 2 } })
      const sends = simulator.stats().sends
      assert.equal(await work(), 'blocked')
      assert.equal((await row(operation.id)).connector_version_id, prior.id)
      assert.equal((await row(operation.id)).state, 'BLOCKED')
      assert.equal(simulator.stats().sends, sends)
    })
    await t.test('editing a proposed URL cannot retarget an already queued operation', async () => {
      const item = await seedLocalTenant(db), queued = await enqueueFiscalOperation(db, item.scope, item.command(), item.options)
      await require('../src/modules/fiscal/connectorService').saveInfileConnection(db, item.scope, { environment: 'TEST', expectedVersion: 1, idempotencyKey: randomUUID(), endpoints: { ISSUE: 'https://provider.example.invalid/new' } }, item.options)
      const sends = simulator.stats().sends
      assert.equal(await work(), 'blocked')
      assert.equal((await row(queued.id)).connector_version_id, item.input.connectorVersionId)
      assert.equal(simulator.stats().sends, sends)
    })
    await t.test('claiming works with both UTC and Guatemala database session time zones', async () => {
      for (const zone of ['UTC', 'America/Guatemala']) {
        const item = await seedLocalTenant(db), queued = await enqueueFiscalOperation(db, item.scope, item.command(), item.options)
        const job = await db.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`)
          return claimNextOperation(tx, { workerId: 'timezone-regression' })
        })
        assert.equal(job.id, queued.id)
        await db.$executeRaw`UPDATE fiscal_operations SET lease_until = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 second' WHERE id=${job.id}::uuid`
        assert.equal(await work(), 'accepted'); assert.equal(await work(), 'done')
      }
    })
    await t.test('database refuses production mode, false certification flags and missing simulation markers', async () => {
      const sample = await db.fiscalOperation.findFirst()
      const data = { company_id: sample.company_id, branch_id: sample.branch_id, connector_id: sample.connector_id, connector_version_id: sample.connector_version_id, created_by: sample.created_by, snapshot: sample.snapshot, snapshot_sha256: sample.snapshot_sha256 }
      for (const change of [{ environment: 'PRODUCTION' }, { mode: 'REAL' }, { snapshot: {} }]) {
        const id = randomUUID()
        await assert.rejects(db.fiscalOperation.create({ data: { ...data, id, source_key: randomUUID(), identifier: `local-${id}`, ...change } }))
      }
    })
    await t.test('executable worker runs against the explicit synthetic database only', async () => {
      const { spawnSync } = require('node:child_process'), { resolve } = require('node:path')
      const result = spawnSync(process.execPath, [resolve(__dirname, '../scripts/fiscal-worker.js'), '--local-simulation', '--once'], { env: { PATH: process.env.PATH, AUNA_FISCAL_LOCAL_TESTS: 'approved', AUNA_FISCAL_LOCAL_DATABASE_URL: database.url }, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout.trim()).certified, false)
    })
    await t.test('enqueue compares establishments in the same branch order used by configuration', async () => {
      const item = await seedLocalTenant(db), branchId = '00000000-0000-4000-8000-000000000001'
      await db.$executeRaw`INSERT INTO branches(id,company_id,name) VALUES (${branchId}::uuid,${item.scope.companyId}::uuid,'Second local branch')`
      const establishment = { ...item.input.establishment, branchId, code: '2', name: 'Second local branch' }
      await db.fiscalEstablishment.create({ data: { company_id: item.scope.companyId, connector_version_id: item.input.connectorVersionId, environment: 'TEST', branch_id: branchId, data: establishment } })
      const command = item.command()
      command.input.profile.establishments.push(establishment)
      command.input.profile.establishments.sort((a, b) => a.branchId.localeCompare(b.branchId))
      const queued = await enqueueFiscalOperation(db, item.scope, command, item.options)
      assert.equal(queued.state, 'QUEUED')
    })
    await t.test('successful worker startup does not read application environment files', async () => {
      const { spawnSync } = require('node:child_process'), { resolve } = require('node:path')
      const result = spawnSync(process.execPath, [resolve(__dirname, '../scripts/fiscal-worker.js'), '--local-simulation', '--once'], {
        env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${resolve(__dirname, 'fixtures/fiscal/env-read-probe.cjs')}`, AUNA_FISCAL_LOCAL_TESTS: 'approved', AUNA_FISCAL_LOCAL_DATABASE_URL: database.url }, encoding: 'utf8', timeout: 10000,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr.includes('APPLICATION_ENV_READ'), false, result.stderr)
      assert.equal(JSON.parse(result.stdout.trim()).certified, false)
      assert.equal(JSON.parse(result.stdout.trim()).state, 'accepted')
    })
  })
})
