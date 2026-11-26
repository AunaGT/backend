const { Router, json } = require('express')

// Install BEFORE the application's general parsers. Parser errors contain the
// raw body, so they must never reach the global logger for credential requests.
function createBodyBoundary() {
  const boundary = Router()
  boundary.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store')
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ code: 'FISCAL_CONTENT_TYPE_INVALID', message: 'Envía la configuración como JSON' })
    next()
  })
  // Mapping drafts may use 128 KiB plus the command envelope. The credential
  // endpoint keeps its smaller limit; no client-supplied flag can enlarge it.
  boundary.use(/^\/infile\/(?:TEST|PRODUCTION)\/profile\/?$/, json({ limit: '132kb', inflate: false }))
  boundary.use(json({ limit: '32kb', inflate: false }))
  boundary.use((error, _req, res, _next) => {
    // Do not log, serialize, forward or interpolate this error: err.body may
    // contain credentials, and even err.message can quote part of invalid JSON.
    const status = error.type === 'entity.too.large' ? 413 : error.status === 415 ? 415 : 400
    res.status(status).json({ code: status === 413 ? 'FISCAL_INPUT_TOO_LARGE' : 'FISCAL_INPUT_INVALID', message: status === 413 ? 'La solicitud supera el tamaño permitido' : 'La solicitud debe contener un JSON válido sin compresión' })
  })
  return boundary
}
module.exports = { createBodyBoundary }
