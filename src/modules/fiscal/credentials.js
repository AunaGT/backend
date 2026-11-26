const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const { fail } = require('./errors')
const CREDENTIAL_FIELDS = Object.freeze(['signUser', 'signKey', 'apiUser', 'apiKey'])
const unavailable = () => fail(503, 'FISCAL_CREDENTIALS_UNAVAILABLE', 'No se pudieron recuperar las credenciales de esta conexión')
const keyError = () => fail(503, 'FISCAL_KEYRING_UNAVAILABLE', 'Falta preparar la clave de cifrado del servidor para guardar conexiones')
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

function base64(value, length) {
  // Includes Base64 overhead and JSON escaping for every allowed UTF-16 value.
  if (typeof value !== 'string' || value.length > 65536) throw unavailable()
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value || length !== undefined && buffer.length !== length) throw unavailable()
  return buffer
}

function readKeyring(env = process.env) {
  try {
    const values = JSON.parse(env.FISCAL_ENCRYPTION_KEYS_JSON), activeKeyId = env.FISCAL_ACTIVE_KEY_ID
    if (!values || typeof values !== 'object' || Array.isArray(values) || !/^[\w-]{1,40}$/.test(activeKeyId || '')) throw keyError()
    const entries = Object.entries(values)
    if (!entries.length || entries.length > 20 || entries.some(([id]) => !/^[\w-]{1,40}$/.test(id))) throw keyError()
    const keys = new Map(entries.map(([id, value]) => [id, base64(value, 32)]))
    if (!keys.has(activeKeyId)) throw keyError()
    return { activeKeyId, keys }
  } catch { throw keyError() }
}

function validateCredentials(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !CREDENTIAL_FIELDS.includes(key))) {
    throw fail(422, 'FISCAL_CREDENTIALS_INVALID', 'Envía únicamente los cuatro campos de conexión')
  }
  const result = {}, fields = {}
  for (const key of CREDENTIAL_FIELDS) {
    const value = values[key], max = key.endsWith('User') ? 256 : 2048
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fields[key] = 'Ingresa un valor válido, sin saltos de línea'
    else result[key] = value
  }
  if (Object.keys(fields).length) throw fail(422, 'FISCAL_CREDENTIALS_INVALID', 'Revisa los campos de conexión', fields)
  return result
}

function aad(context, keyId) {
  if (!context || !uuid.test(context.companyId || '') || !uuid.test(context.connectorId || '') || !['TEST', 'PRODUCTION'].includes(context.environment) || !Number.isSafeInteger(context.credentialVersion) || context.credentialVersion < 1) throw unavailable()
  return Buffer.from(JSON.stringify(['auna:fiscal:credentials:v1', context.companyId, context.connectorId, context.environment, context.credentialVersion, keyId]))
}

function sealCredentials(context, values, keyring) {
  const validated = validateCredentials(values), keyId = keyring?.activeKeyId, key = keyring?.keys?.get(keyId)
  if (!Buffer.isBuffer(key) || key.length !== 32) throw keyError()
  const iv = randomBytes(12), plain = Buffer.from(JSON.stringify(validated))
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad(context, keyId))
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    return { version: 1, keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  } finally { plain.fill(0) }
}

function openCredentials(context, envelope, keyring) {
  let plain
  try {
    if (!envelope || envelope.version !== 1 || Object.keys(envelope).some(key => !['version', 'keyId', 'iv', 'tag', 'ciphertext'].includes(key))) throw unavailable()
    const key = keyring?.keys?.get(envelope.keyId)
    if (!Buffer.isBuffer(key) || key.length !== 32) throw unavailable()
    const decipher = createDecipheriv('aes-256-gcm', key, base64(envelope.iv, 12))
    decipher.setAAD(aad(context, envelope.keyId))
    decipher.setAuthTag(base64(envelope.tag, 16))
    plain = Buffer.concat([decipher.update(base64(envelope.ciphertext)), decipher.final()])
    return validateCredentials(JSON.parse(plain.toString('utf8')))
  } catch { throw unavailable() }
  finally { plain?.fill(0) }
}
module.exports = { CREDENTIAL_FIELDS, readKeyring, validateCredentials, sealCredentials, openCredentials }
