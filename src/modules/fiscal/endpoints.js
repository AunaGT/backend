const { isIP } = require('node:net')
const { fail } = require('./errors')
const ENDPOINT_ACTIONS = Object.freeze(['ISSUE', 'CREDIT_NOTE', 'CANCEL', 'LOOKUP'])
const message = 'Usa una URL HTTPS sin credenciales, parámetros ni fragmentos; no se admiten destinos locales ni direcciones IP.'
const invalid = field => fail(422, 'FISCAL_ENDPOINT_INVALID', 'Revisa las URLs de la conexión', { [field]: message })

function normalizeEndpoints(raw) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || !Object.keys(raw).length || Object.keys(raw).some(key => !ENDPOINT_ACTIONS.includes(key))) throw invalid('endpoints')
  const result = {}
  for (const action of ENDPOINT_ACTIONS.filter(key => Object.hasOwn(raw, key))) {
    const value = raw[action]
    if (value === null) { result[action] = null; continue }
    try {
      if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw Error()
      const url = new URL(value), host = url.hostname
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|arpa)$/.test(host)) throw Error()
      result[action] = url.href
    } catch { throw invalid(`endpoints.${action}`) }
  }
  return result
}
function endpointSettings(raw = {}) {
  return Object.fromEntries(ENDPOINT_ACTIONS.map(action => [action, raw?.[action] ?? null]))
}
module.exports = { ENDPOINT_ACTIONS, normalizeEndpoints, endpointSettings }
