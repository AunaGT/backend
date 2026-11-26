const { createHash, createHmac } = require('node:crypto')
const { canonicalJson } = require('./localPolicy')
const { fail } = require('./errors')
const transaction = (db, run) => typeof db.$transaction === 'function' ? db.$transaction(run, { timeout: 15000, maxWait: 10000 }) : run(db)
function operationDto(row) {
  return { id: row.id, action: row.action, environment: row.environment, state: row.state, revision: row.revision, simulationOnly: true, certified: false, retryAllowed: false, reconcileAllowed: row.state === 'UNKNOWN', updatedAt: row.updated_at.toISOString() }
}
function commandDigest(scope, command, keyring, keyId = keyring.activeKeyId) {
  const key = keyring.keys.get(keyId)
  if (!key) throw fail(503, 'FISCAL_KEYRING_UNAVAILABLE', 'Falta una clave necesaria para recuperar este intento local')
  return createHmac('sha256', key).update(canonicalJson([scope.companyId, scope.branchId, scope.actorId, command])).digest('hex')
}
async function recordStateEvent(tx, row) {
  const result = { operationId: row.id, state: row.state, revision: row.revision, errorCode: row.error_code, simulationOnly: true, certified: false, system: true }
  await tx.fiscalEvent.create({ data: { company_id: row.company_id, connector_id: row.connector_id, environment: row.environment, operation_id: row.id, actor_id: row.created_by, action: 'LOCAL_STATE', request_key: `${row.id}:${row.revision}`, input_hash: createHash('sha256').update(canonicalJson(result)).digest('hex'), hash_key_id: 'LOCAL_STATE_V1', result } })
}
async function ownedOperation(tx, job) {
  const rows = await tx.$queryRaw`SELECT id FROM fiscal_operations WHERE id=${job.id}::uuid AND company_id=${job.company_id}::uuid AND lease_token=${job.lease_token}::uuid AND lease_until>(statement_timestamp() AT TIME ZONE 'UTC') FOR UPDATE`
  return rows.length ? tx.fiscalOperation.findUnique({ where: { id: job.id } }) : null
}
function localInbox(outcome, job) {
  if (!outcome || !['LOCAL_ACCEPTED', 'LOCAL_REJECTED'].includes(outcome.kind) || outcome.certified !== false || outcome.identifier !== job.identifier || outcome.xmlSha256 !== job.xml_sha256 || !/^simulation-[\da-f-]{36}$/i.test(outcome.receiptId || '')) return null
  return { kind: outcome.kind, identifier: job.identifier, xmlSha256: job.xml_sha256, receiptId: outcome.receiptId, certified: false }
}
module.exports = { transaction, operationDto, commandDigest, recordStateEvent, ownedOperation, localInbox }
