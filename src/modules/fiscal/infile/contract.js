const { fail } = require('../errors')

function contractFor(environment) {
  if (!['TEST', 'PRODUCTION'].includes(environment)) throw fail(422, 'FISCAL_ENVIRONMENT_INVALID', 'Selecciona un entorno válido')
  // No caller payload or deployment flag may lift the user's current network ban.
  return Object.freeze({
    id: 'infile-unified-offline-v1', environment, verified: false, endpoint: null,
    externalSendingAllowed: false, identifierPolicy: null, schemas: null,
    allowedProfiles: Object.freeze([]),
    responsePolicy: 'UNCONFIRMED', blockingCode: 'FISCAL_EXTERNAL_DISABLED',
  })
}

function assertExternalSendingAllowed() {
  throw fail(409, 'FISCAL_EXTERNAL_DISABLED', 'Los envíos y pruebas reales con Infile están deshabilitados. Esta etapa es únicamente local.')
}
module.exports = { contractFor, assertExternalSendingAllowed }
