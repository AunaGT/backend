const { readKeyring } = require('./credentials')
const { uuid } = require('./localPolicy')
const { scoped } = require('./operations')
const { fail } = require('./errors')
const { isLocalSimulator } = require('./localSimulator')
const { claimNextOperation, finishSending } = require('./worker')
const { transaction, operationDto, commandDigest } = require('./storage')
function getRecoveryAction(_contract, operation) { return operation?.mode === 'LOCAL_SIMULATION' && operation.environment === 'TEST' ? 'QUERY_LOCAL_SIMULATOR' : 'MANUAL' }
async function reconcileFiscalOperation(db, scope, id, raw, options = {}) {
  const s = scoped(scope, 'retry')
  if (!uuid.test(id || '') || !raw || Object.keys(raw).some(key => !['expectedVersion', 'idempotencyKey'].includes(key)) || !uuid.test(raw.idempotencyKey || '') || !Number.isSafeInteger(raw.expectedVersion)) throw fail(422, 'FISCAL_LOCAL_INPUT_INVALID', 'Revisa la consulta local')
  if (!isLocalSimulator(options.simulator)) throw fail(409, 'FISCAL_EXTERNAL_DISABLED', 'La recuperación de esta etapa solo consulta al simulador local')
  const command = { operationId: id, expectedVersion: raw.expectedVersion, idempotencyKey: raw.idempotencyKey.toLowerCase() }, keyring = (options.keyring || readKeyring)()
  const existing = await db.fiscalEvent.findUnique({ where: { company_id_actor_id_action_request_key: { company_id: s.companyId, actor_id: s.actorId, action: 'RECONCILE_LOCAL', request_key: command.idempotencyKey } } })
  if (existing) {
    if (existing.input_hash !== commandDigest(s, command, keyring, existing.hash_key_id)) throw fail(409, 'FISCAL_IDEMPOTENCY_CONFLICT', 'Este intento de consulta ya se utilizó')
    return existing.result
  }
  const row = await db.fiscalOperation.findFirst({ where: { id, company_id: s.companyId, branch_id: s.branchId } })
  if (!row) throw fail(404, 'FISCAL_OPERATION_NOT_FOUND', 'No se encontró la operación local')
  if (row.state !== 'UNKNOWN' || row.revision !== command.expectedVersion || getRecoveryAction(null, row) !== 'QUERY_LOCAL_SIMULATOR') throw fail(409, 'FISCAL_STALE_VERSION', 'Recarga la operación antes de consultar')
  const job = await claimNextOperation(db, { workerId: `lookup-${s.actorId}`, operationId: id, expectedVersion: command.expectedVersion })
  if (!job) throw fail(409, 'FISCAL_OPERATION_BUSY', 'La operación local ya está siendo revisada')
  const outcome = await options.simulator.lookup({ identifier: job.identifier, xmlSha256: job.xml_sha256 })
  return transaction(db, async tx => {
    if (!await finishSending(tx, job, outcome)) throw fail(409, 'FISCAL_LEASE_LOST', 'La consulta perdió su turno; recarga el resultado')
    const updated = await tx.fiscalOperation.findUnique({ where: { id } }), result = operationDto(updated)
    await tx.fiscalEvent.create({ data: { company_id: s.companyId, connector_id: updated.connector_id, environment: 'TEST', operation_id: id, actor_id: s.actorId, action: 'RECONCILE_LOCAL', request_key: command.idempotencyKey, input_hash: commandDigest(s, command, keyring), hash_key_id: keyring.activeKeyId, result } })
    return result
  })
}
module.exports = { reconcileFiscalOperation, getRecoveryAction }
