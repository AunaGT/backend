/**
 * Scheduler local: vencimiento periódico de cotizaciones/pedidos.
 */

const { expireCommercialDocuments } = require('../services/commercialDocumentExpiry')

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1 h

let timer = null
let running = false

async function runCommercialDocumentExpiryJob() {
  if (running) return null
  running = true
  try {
    const summary = await expireCommercialDocuments()
    if (summary.quotesExpired || summary.ordersExpired || summary.reservationsExpired) {
      console.log('[commercial-doc-expiry]', summary)
    }
    return summary
  } catch (e) {
    console.error('[commercial-doc-expiry] error', e.message)
    return null
  } finally {
    running = false
  }
}

function startCommercialDocumentScheduler() {
  if (timer) return
  const intervalMs = Math.max(
    5 * 60 * 1000,
    parseInt(process.env.COMMERCIAL_DOC_EXPIRY_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10) ||
      DEFAULT_INTERVAL_MS
  )
  void runCommercialDocumentExpiryJob()
  timer = setInterval(() => {
    void runCommercialDocumentExpiryJob()
  }, intervalMs)
  timer.unref?.()
  console.log(`[commercial-doc-expiry] scheduler cada ${Math.round(intervalMs / 60000)} min`)
}

function stopCommercialDocumentScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  runCommercialDocumentExpiryJob,
  startCommercialDocumentScheduler,
  stopCommercialDocumentScheduler,
}
