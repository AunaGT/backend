const { randomUUID } = require('node:crypto')
const { authorize } = require('./permissions')
const { readKeyring } = require('./credentials')
const { captureLocalInput, canonicalJson, uuid } = require('./localPolicy')
const { fail } = require('./errors')
const { transaction, operationDto, commandDigest, recordStateEvent } = require('./storage')
function scoped(scope, action = 'view') {
  const s = authorize(scope, action)
  if (!uuid.test(s.branchId || '')) throw fail(400, 'FISCAL_SCOPE_REQUIRED', 'Selecciona una sucursal para esta operación')
  return { ...s, branchId: s.branchId.toLowerCase() }
}
async function readFiscalOperation(db, scope, id) {
  const s = scoped(scope)
  if (!uuid.test(id || '')) throw fail(404, 'FISCAL_OPERATION_NOT_FOUND', 'No se encontró la operación local')
  const row = await db.fiscalOperation.findFirst({ where: { id, company_id: s.companyId, branch_id: s.branchId } })
  if (!row) throw fail(404, 'FISCAL_OPERATION_NOT_FOUND', 'No se encontró la operación local')
  return operationDto(row)
}
async function enqueueFiscalOperation(db, scope, raw, options = {}) {
  const s = scoped(scope, 'test')
  if (!raw || Object.keys(raw).some(key => !['action', 'sourceKey', 'idempotencyKey', 'input'].includes(key)) || raw.action !== 'ISSUE' || !uuid.test(raw.sourceKey || '') || !uuid.test(raw.idempotencyKey || '')) throw fail(422, 'FISCAL_LOCAL_INPUT_INVALID', 'Revisa la solicitud de muestra local')
  const captured = captureLocalInput(raw.input), input = captured.input
  if (input.companyId !== s.companyId || input.branchId !== s.branchId) throw fail(404, 'FISCAL_SOURCE_NOT_FOUND', 'No se encontró el origen local en esta sucursal')
  if (input.saleId !== raw.sourceKey) throw fail(409, 'FISCAL_SOURCE_CONFLICT', 'El origen no coincide con la muestra congelada')
  const command = { action: raw.action, sourceKey: raw.sourceKey, idempotencyKey: raw.idempotencyKey.toLowerCase(), input }, keyring = (options.keyring || readKeyring)()
  return transaction(db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-local-command:${s.companyId}:${s.actorId}:${command.idempotencyKey}`},0))`
    const old = await tx.fiscalEvent.findUnique({ where: { company_id_actor_id_action_request_key: { company_id: s.companyId, actor_id: s.actorId, action: 'ENQUEUE_LOCAL', request_key: command.idempotencyKey } } })
    if (old) {
      if (old.input_hash !== commandDigest(s, command, keyring, old.hash_key_id)) throw fail(409, 'FISCAL_IDEMPOTENCY_CONFLICT', 'Este intento local ya se utilizó con otros datos')
      return old.result
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-connection:${s.companyId}:TEST`},0))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-local-source:${s.companyId}:${s.branchId}:${command.sourceKey}`},0))`
    let row = await tx.fiscalOperation.findFirst({ where: { company_id: s.companyId, branch_id: s.branchId, action: 'ISSUE', source_key: command.sourceKey } })
    if (row && row.snapshot_sha256 !== captured.sha256) throw fail(409, 'FISCAL_SOURCE_CONFLICT', 'El origen local ya se preparó con otros datos')
    if (!row) {
      const version = await tx.fiscalConnectorVersion.findFirst({ where: { id: input.connectorVersionId, company_id: s.companyId, environment: 'TEST' }, include: { connector: true, establishments: { orderBy: { branch_id: 'asc' } } } })
      if (!version || !version.profile) throw fail(409, 'FISCAL_PROFILE_INCOMPLETE', 'Falta la versión del perfil local')
      if (version.number !== version.connector.revision || ['PAUSED', 'REVOKED'].includes(version.connector.state)) throw fail(409, 'FISCAL_STALE_VERSION', 'Revisa la versión de configuración antes de encolar')
      const profile = { ...version.profile, establishments: version.establishments.map(r => r.data) }
      if (canonicalJson(input.profile) !== canonicalJson(profile) || canonicalJson(input.emitter) !== canonicalJson(profile.emitter) || !profile.establishments.some(r => r.branchId === s.branchId && canonicalJson(r) === canonicalJson(input.establishment))) throw fail(409, 'FISCAL_PROFILE_INCOMPLETE', 'El contexto no coincide con la versión fiscal guardada')
      const id = randomUUID()
      row = await tx.fiscalOperation.create({ data: { id, company_id: s.companyId, branch_id: s.branchId, connector_id: version.connector_id, connector_version_id: version.id, environment: 'TEST', mode: 'LOCAL_SIMULATION', action: 'ISSUE', source_key: command.sourceKey, created_by: s.actorId, identifier: `local-${id}`, snapshot: input, snapshot_sha256: captured.sha256 } })
      await recordStateEvent(tx, row)
    }
    const result = operationDto(row)
    await tx.fiscalEvent.create({ data: { company_id: s.companyId, connector_id: row.connector_id, environment: 'TEST', operation_id: row.id, actor_id: s.actorId, action: 'ENQUEUE_LOCAL', request_key: command.idempotencyKey, input_hash: commandDigest(s, command, keyring), hash_key_id: keyring.activeKeyId, result } })
    return result
  })
}
module.exports = { enqueueFiscalOperation, readFiscalOperation, scoped }
