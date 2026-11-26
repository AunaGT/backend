const { randomUUID, createHash } = require('node:crypto')
const { Prisma } = require('@prisma/client')
const { fail } = require('./errors')
const { captureLocalInput, uuid } = require('./localPolicy')
const { isLocalSimulator } = require('./localSimulator')
const { buildLocalIssueXml, validateAndMatchXml } = require('./infile/xml')
const { transaction, ownedOperation, localInbox, recordStateEvent } = require('./storage')
const clearedLease = { lease_token: null, lease_until: null, worker_id: null }

async function expireSending(tx) {
  const expired = await tx.$queryRaw`SELECT id FROM fiscal_operations WHERE state='SENDING' AND lease_until<=(statement_timestamp() AT TIME ZONE 'UTC') ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED`
  for (const old of expired) {
    const row = await tx.fiscalOperation.update({ where: { id: old.id }, data: { state: 'UNKNOWN', error_code: 'LOCAL_WORKER_LOST', revision: { increment: 1 }, ...clearedLease } })
    await tx.fiscalAttempt.updateMany({ where: { operation_id: row.id, kind: 'SEND', finished_at: null }, data: { finished_at: new Date(), outcome: 'LOCAL_UNKNOWN' } })
    await recordStateEvent(tx, row)
  }
}
async function claimNextOperation(db, { workerId, operationId, expectedVersion } = {}) {
  if (typeof workerId !== 'string' || !/^[\w.-]{1,80}$/.test(workerId) || operationId && (!uuid.test(operationId) || !Number.isSafeInteger(expectedVersion))) throw fail(422, 'FISCAL_WORKER_INVALID', 'Identifica el trabajador local')
  return transaction(db, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fiscal-local-claim',0))`
    const now = new Date()
    const utcNow = Prisma.sql`(statement_timestamp() AT TIME ZONE 'UTC')`
    await expireSending(tx)
    const [active] = await tx.$queryRaw`SELECT count(*)::integer AS count FROM fiscal_operations WHERE lease_until>${utcNow}`
    if (active.count >= 2) return null
    const filter = operationId ? Prisma.sql`o.id=${operationId}::uuid AND o.state='UNKNOWN' AND o.revision=${expectedVersion}` : Prisma.sql`o.state IN('QUEUED','ACCEPTED') AND o.available_at<=${utcNow}`
    const token = randomUUID()
    const rows = await tx.$queryRaw`WITH picked AS (
      SELECT o.id FROM fiscal_operations o WHERE ${filter} AND o.mode='LOCAL_SIMULATION' AND o.environment='TEST'
        AND (o.lease_until IS NULL OR o.lease_until<=${utcNow})
        AND NOT EXISTS(SELECT 1 FROM fiscal_operations other WHERE other.connector_id=o.connector_id AND other.lease_until>${utcNow})
      ORDER BY o.available_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED
    ) UPDATE fiscal_operations o SET lease_token=${token}::uuid,lease_until=${utcNow}+interval '120 seconds',worker_id=${workerId},revision=o.revision+1,updated_at=${utcNow}
      FROM picked p WHERE o.id=p.id RETURNING o.id`
    if (!rows.length) return null
    let row = await tx.fiscalOperation.findUnique({ where: { id: rows[0].id } })
    if (operationId) {
      await tx.fiscalAttempt.updateMany({ where: { operation_id: row.id, kind: 'LOOKUP', finished_at: null }, data: { finished_at: now, outcome: 'LOCAL_UNKNOWN' } })
      row = await tx.fiscalOperation.update({ where: { id: row.id }, data: { attempt_count: { increment: 1 } } })
      const attempt = await tx.fiscalAttempt.create({ data: { company_id: row.company_id, operation_id: row.id, number: row.attempt_count, kind: 'LOOKUP', lease_token: token } })
      row.attempt_id = attempt.id
    }
    return row
  })
}
async function beginSending(db, job, { xml, sha256 }) {
  return transaction(db, async tx => {
    const row = await ownedOperation(tx, job)
    if (!row || row.state !== 'QUEUED') return null
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fiscal-connection:${row.company_id}:TEST`},0))`
    const version = await tx.fiscalConnectorVersion.findUnique({ where: { id: row.connector_version_id }, select: { number: true, connector: { select: { revision: true, state: true } } } })
    if (!version || version.number !== version.connector.revision || ['PAUSED', 'REVOKED'].includes(version.connector.state)) {
      const blocked = await tx.fiscalOperation.update({ where: { id: row.id }, data: { state: 'BLOCKED', error_code: 'LOCAL_CONFIGURATION_CHANGED', revision: { increment: 1 }, ...clearedLease } })
      await recordStateEvent(tx, blocked); return null
    }
    if (!Buffer.isBuffer(xml) || xml.length > 2097152 || createHash('sha256').update(xml).digest('hex') !== sha256 || !buildLocalIssueXml(row.snapshot).equals(xml)) throw fail(422, 'FISCAL_XML_MISMATCH', 'Los bytes no corresponden a la muestra local')
    const started = await tx.fiscalOperation.update({ where: { id: row.id }, data: { state: 'SENDING', xml_bytes: xml, xml_sha256: sha256, attempt_count: { increment: 1 }, revision: { increment: 1 }, error_code: null } })
    const attempt = await tx.fiscalAttempt.create({ data: { company_id: row.company_id, operation_id: row.id, number: started.attempt_count, kind: 'SEND', lease_token: row.lease_token } })
    await recordStateEvent(tx, started)
    return { ...started, attempt_id: attempt.id }
  })
}
async function finishSending(db, job, outcome) {
  return transaction(db, async tx => {
    const row = await ownedOperation(tx, job)
    if (!row) return false
    const attempt = await tx.fiscalAttempt.findFirst({ where: { id: job.attempt_id, company_id: row.company_id, operation_id: row.id, lease_token: row.lease_token, finished_at: null } })
    if (!attempt || row.state !== (attempt.kind === 'SEND' ? 'SENDING' : 'UNKNOWN')) return false
    const inbox = localInbox(outcome, row), kind = inbox?.kind || 'LOCAL_UNKNOWN', state = kind === 'LOCAL_ACCEPTED' ? 'ACCEPTED' : kind === 'LOCAL_REJECTED' ? 'REJECTED' : 'UNKNOWN'
    await tx.fiscalAttempt.update({ where: { id: attempt.id }, data: { outcome: kind, finished_at: new Date(), ...(inbox ? { inbox } : {}) } })
    const updated = await tx.fiscalOperation.update({ where: { id: row.id }, data: { state, ...(state === 'ACCEPTED' ? { accepted_attempt_id: attempt.id } : {}), error_code: state === 'UNKNOWN' ? 'LOCAL_RESULT_UNKNOWN' : state === 'REJECTED' ? 'LOCAL_REJECTED' : null, revision: { increment: 1 }, ...clearedLease } })
    await recordStateEvent(tx, updated)
    return true
  })
}
async function materializeLocalResult(db, job) {
  return transaction(db, async tx => {
    const row = await ownedOperation(tx, job)
    if (!row || row.state !== 'ACCEPTED') return false
    const attempt = await tx.fiscalAttempt.findFirst({ where: { id: row.accepted_attempt_id, company_id: row.company_id, operation_id: row.id, outcome: 'LOCAL_ACCEPTED' } })
    const inbox = localInbox(attempt?.inbox, row)
    if (!inbox) throw fail(422, 'LOCAL_INBOX_INVALID', 'Falta la evidencia local del resultado')
    const updated = await tx.fiscalOperation.update({ where: { id: row.id }, data: { state: 'DONE', result: { simulationOnly: true, certified: false, operationId: row.id, receiptId: inbox.receiptId, xmlSha256: row.xml_sha256 }, revision: { increment: 1 }, error_code: null, ...clearedLease } })
    await recordStateEvent(tx, updated)
    return true
  })
}
async function localFailure(db, job) {
  return transaction(db, async tx => {
    const row = await ownedOperation(tx, job)
    if (!row) return 'lost'
    if (row.state === 'SENDING') {
      const attempt = await tx.fiscalAttempt.findFirst({ where: { operation_id: row.id, lease_token: row.lease_token, finished_at: null, kind: 'SEND' } })
      if (attempt) await tx.fiscalAttempt.update({ where: { id: attempt.id }, data: { outcome: 'LOCAL_UNKNOWN', finished_at: new Date() } })
      const updated = await tx.fiscalOperation.update({ where: { id: row.id }, data: { state: 'UNKNOWN', error_code: 'LOCAL_RESULT_UNKNOWN', revision: { increment: 1 }, ...clearedLease } })
      await recordStateEvent(tx, updated); return 'unknown'
    }
    if (!['QUEUED', 'ACCEPTED'].includes(row.state)) return 'lost'
    const failures = row.local_failures + 1, retry = failures <= 3
    const updated = await tx.fiscalOperation.update({ where: { id: row.id }, data: { state: retry ? row.state : 'BLOCKED', local_failures: failures, error_code: retry ? 'LOCAL_STEP_RETRY' : 'LOCAL_RETRIES_EXHAUSTED', available_at: new Date(Date.now() + ([30000, 120000, 600000][failures - 1] || 0)), revision: { increment: 1 }, ...clearedLease } })
    await recordStateEvent(tx, updated)
    return retry ? 'retry' : 'blocked'
  })
}
async function processNextFiscalOperation(db, { workerId, simulator } = {}) {
  if (!isLocalSimulator(simulator)) throw fail(409, 'FISCAL_EXTERNAL_DISABLED', 'Este trabajador solo admite el simulador local integrado')
  const job = await claimNextOperation(db, { workerId })
  if (!job) return 'idle'
  let lost = false, busy = false
  const heartbeat = setInterval(async () => {
    if (busy) return; busy = true
    try { const result = await db.fiscalOperation.updateMany({ where: { id: job.id, company_id: job.company_id, lease_token: job.lease_token, lease_until: { gt: new Date() } }, data: { lease_until: new Date(Date.now() + 120000) } }); if (result.count !== 1) lost = true } catch { lost = true } finally { busy = false }
  }, 15000)
  heartbeat.unref?.()
  try {
    const captured = captureLocalInput(job.snapshot)
    if (captured.sha256 !== job.snapshot_sha256) throw fail(422, 'LOCAL_SNAPSHOT_INVALID', 'El snapshot local no coincide')
    if (job.state === 'ACCEPTED') return await materializeLocalResult(db, job) ? 'done' : 'lost'
    const xml = buildLocalIssueXml(captured.input), metadata = await validateAndMatchXml(xml, { kind: 'LOCAL_ISSUE', input: captured.input })
    if (lost) return 'lost'
    const started = await beginSending(db, job, { xml, sha256: metadata.sha256 })
    if (!started) return 'blocked'
    const outcome = await simulator.send({ identifier: started.identifier, xmlSha256: started.xml_sha256, xml: Buffer.from(started.xml_bytes) })
    if (!await finishSending(db, started, outcome)) return 'lost'
    return outcome.kind === 'LOCAL_ACCEPTED' ? 'accepted' : outcome.kind === 'LOCAL_REJECTED' ? 'rejected' : 'unknown'
  } catch { return localFailure(db, job) } finally { clearInterval(heartbeat) }
}
module.exports = { claimNextOperation, beginSending, finishSending, processNextFiscalOperation }
