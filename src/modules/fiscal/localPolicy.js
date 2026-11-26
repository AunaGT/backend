const { createHash } = require('node:crypto')
const { fail } = require('./errors')
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const keys = ['version', 'source', 'companyId', 'branchId', 'saleId', 'connectorVersionId', 'contractId', 'environment', 'currency', 'issuedAt', 'verification', 'externalSendingAllowed', 'profile', 'emitter', 'establishment', 'receiver', 'lines', 'totals', 'renderProfiles']
const invalid = () => fail(422, 'FISCAL_LOCAL_INPUT_INVALID', 'La cola de esta etapa solo admite muestras locales sintéticas')
function canonicalJson(value) {
  let nodes = 0
  function visit(row, depth) {
    if (++nodes > 50000 || depth > 32) throw invalid()
    if (row === null || typeof row === 'string' || typeof row === 'boolean') return row
    if (typeof row === 'number' && Number.isFinite(row) && (!Number.isInteger(row) || Number.isSafeInteger(row))) return row
    if (Array.isArray(row)) return row.map(v => visit(v, depth + 1))
    if (!row || Object.getPrototypeOf(row) !== Object.prototype) throw invalid()
    return Object.fromEntries(Object.keys(row).sort().map(key => {
      if (/^(?:credentials|ciphertext|signKey|apiKey|password|token)$/i.test(key)) throw invalid()
      return [key, visit(row[key], depth + 1)]
    }))
  }
  return JSON.stringify(visit(value, 0))
}
function captureLocalInput(raw) {
  if (!raw || Object.keys(raw).some(key => !keys.includes(key)) || raw.version !== 1 || raw.environment !== 'TEST' || raw.source !== 'LOCAL_SAMPLE' || raw.verification !== 'UNCONFIRMED' || raw.externalSendingAllowed !== false || raw.contractId !== 'infile-unified-offline-v1' || raw.currency !== 'GTQ') throw invalid()
  if (['companyId', 'branchId', 'saleId', 'connectorVersionId'].some(key => !uuid.test(raw[key] || '')) || !Array.isArray(raw.lines) || !raw.lines.length || raw.lines.length > 500) throw invalid()
  const amounts = ['gross', 'discount', 'taxable', 'tax', 'total']
  if (amounts.some(key => typeof raw.totals?.[key] !== 'string') || raw.lines.some(row => [...amounts, 'quantity', 'unitPrice', 'baseQuantity'].some(key => typeof row?.[key] !== 'string') || typeof row.taxRule?.rate !== 'string')) throw invalid()
  const json = canonicalJson(raw)
  if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw invalid()
  return { input: JSON.parse(json), json, sha256: createHash('sha256').update(json).digest('hex') }
}
function localDatabaseLocation(env) {
  try {
    const url = new URL(env.AUNA_FISCAL_LOCAL_DATABASE_URL)
    if (env.AUNA_FISCAL_LOCAL_TESTS !== 'approved' || !['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== 'localhost' || url.username !== 'auna_fiscal_test' || url.password || url.hash || !/^\/tmp\/auna-fiscal-pg\.[A-Za-z0-9]+\/socket$/.test(url.searchParams.get('host') || '')) throw Error()
    const keys = [...url.searchParams.keys()]
    if (new Set(keys).size !== keys.length || keys.some(key => !['host', 'connection_limit'].includes(key))) throw Error()
    if (url.searchParams.has('connection_limit') && !/^(?:[1-9]|1\d|20)$/.test(url.searchParams.get('connection_limit'))) throw Error()
    return url
  } catch { throw fail(422, 'FISCAL_LOCAL_DATABASE_REQUIRED', 'Se requiere una base local desechable autorizada, no la base de la aplicación') }
}
function localDatabaseUrl(env) {
  const url = localDatabaseLocation(env)
  if (!/^\/fiscal_[a-f0-9]{32}$/.test(url.pathname)) throw fail(422, 'FISCAL_LOCAL_DATABASE_REQUIRED', 'Se requiere una base local desechable autorizada, no la base de la aplicación')
  return url.href
}
module.exports = { captureLocalInput, canonicalJson, uuid, localDatabaseUrl, localDatabaseLocation }
