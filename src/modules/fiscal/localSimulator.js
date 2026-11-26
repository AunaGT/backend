const { randomUUID } = require('node:crypto')
const { fail } = require('./errors')
const instances = new WeakSet()
function createLocalSimulator({ outcomes = ['ACCEPT'], delayMs = 0 } = {}) {
  if (!Array.isArray(outcomes) || !outcomes.length || outcomes.some(v => !['ACCEPT', 'REJECT', 'LOSE_RESPONSE', 'UNAVAILABLE'].includes(v)) || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw fail(422, 'FISCAL_LOCAL_SIMULATOR_INVALID', 'Selecciona un caso local válido')
  const pending = [...outcomes], receipts = new Map()
  let sends = 0, queries = 0
  const simulator = Object.freeze({
    async send({ identifier, xmlSha256 }) {
      sends++
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      const mode = pending.shift() || 'ACCEPT'
      if (mode === 'UNAVAILABLE') throw fail(503, 'LOCAL_UNAVAILABLE', 'Simulación no disponible')
      const old = receipts.get(identifier)
      if (old && old.xmlSha256 !== xmlSha256) throw fail(409, 'LOCAL_IDENTIFIER_CONFLICT', 'Identificador local usado con otros bytes')
      const result = old || Object.freeze({ kind: mode === 'REJECT' ? 'LOCAL_REJECTED' : 'LOCAL_ACCEPTED', identifier, xmlSha256, receiptId: `simulation-${randomUUID()}`, certified: false })
      receipts.set(identifier, result)
      if (mode === 'LOSE_RESPONSE') throw fail(503, 'LOCAL_RESPONSE_LOST', 'Respuesta simulada perdida')
      return structuredClone(result)
    },
    async lookup({ identifier, xmlSha256 }) {
      queries++
      const result = receipts.get(identifier)
      return result?.xmlSha256 === xmlSha256 ? structuredClone(result) : null
    },
    stats: () => ({ sends, queries }),
  })
  instances.add(simulator)
  return simulator
}
function isLocalSimulator(value) { return !!value && instances.has(value) }
module.exports = { createLocalSimulator, isLocalSimulator }
