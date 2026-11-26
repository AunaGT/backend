const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')
const { PrismaClient } = require('@prisma/client')

async function disposableDatabase(run) {
  const url = require('../../../src/modules/fiscal/localPolicy').localDatabaseLocation(process.env)
  if (url.pathname !== '/postgres') throw Error('Dedicated disposable fiscal admin database required')
  const admin = url.href, name = `fiscal_${randomUUID().replaceAll('-', '')}`
  execFileSync('psql', [admin, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`], { stdio: 'pipe' })
  url.pathname = `/${name}`
  const db = new PrismaClient({ datasources: { db: { url: url.href } } })
  try {
    for (const file of ['tests/fixtures/fiscal/bootstrap-local.sql', 'prisma/migrations/20261023210000_fiscal_connections/migration.sql', 'prisma/migrations/20261023220000_fiscal_preparation/migration.sql', 'prisma/migrations/20261023230000_fiscal_local_queue/migration.sql', 'prisma/migrations/20261023235000_fiscal_proposed_endpoints/migration.sql']) execFileSync('psql', [url.href, '-v', 'ON_ERROR_STOP=1', '-f', resolve(__dirname, '../../..', file)], { stdio: 'pipe' })
    await run(db, { url: url.href })
  } finally { await db.$disconnect(); execFileSync('psql', [admin, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${name} WITH (FORCE)`], { stdio: 'pipe' }) }
}
async function seedLocalTenant(db) {
  const { fixture } = require('./preparation.cjs'), { localInput } = require('./local-input.cjs')
  const f = fixture(); for (const key of Object.keys(f.ids)) f.ids[key] = randomUUID()
  const scope = { companyId: f.ids.company, branchId: f.ids.branch, actorId: f.ids.actor, permissions: ['fiscal.manage', 'fiscal.test', 'fiscal.retry'] }
  await db.$executeRaw`INSERT INTO companies(id) VALUES (${scope.companyId}::uuid)`
  await db.$executeRaw`INSERT INTO branches(id,company_id,name) VALUES (${scope.branchId}::uuid,${scope.companyId}::uuid,'Local canary branch')`
  // Regenerate the fixture with its original internal references, then replace identities consistently.
  const original = fixture().ids, remap = JSON.stringify(localInput()).replace(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/gi, id => f.ids[Object.keys(original).find(key => original[key] === id)] || id)
  const input = JSON.parse(remap), { establishments, ...profile } = input.profile
  await db.fiscalConnector.create({ data: { id: f.ids.connector, company_id: scope.companyId, environment: 'TEST' } })
  await db.fiscalConnectorVersion.create({ data: { id: f.ids.version, company_id: scope.companyId, connector_id: f.ids.connector, number: 1, environment: 'TEST', created_by: scope.actorId, profile } })
  await db.fiscalEstablishment.create({ data: { company_id: scope.companyId, connector_version_id: f.ids.version, environment: 'TEST', branch_id: scope.branchId, data: establishments[0] } })
  const keyring = require('../../../src/modules/fiscal/credentials').readKeyring({ FISCAL_ACTIVE_KEY_ID: 'test-only', FISCAL_ENCRYPTION_KEYS_JSON: JSON.stringify({ 'test-only': Buffer.alloc(32, 21).toString('base64') }) })
  return { scope, input, options: { keyring: () => keyring }, command: () => { const sourceKey = randomUUID(); return { action: 'ISSUE', sourceKey, idempotencyKey: randomUUID(), input: { ...structuredClone(input), saleId: sourceKey } } } }
}
module.exports = { disposableDatabase, seedLocalTenant }
