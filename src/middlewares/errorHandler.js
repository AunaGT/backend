const unavailableDatabaseCodes = new Set(['P1001', 'P1002', 'P1017', 'P2024'])

function errorHandler(err, req, res, next) {
  console.error(err)
  if (res.headersSent) return next(err)
  if (unavailableDatabaseCodes.has(err.code || err.errorCode)) {
    return res.status(503).json({ message: 'La conexión con la base de datos no está disponible temporalmente. Intenta de nuevo.' })
  }
  // Guardas de disputas/reembolsos en la base: otro proceso cambió el cobro; 409 sin exponer texto SQL.
  if (!err.status && /\b(dispute|refund)_[a-z_]+\b/.test(String(err.message || ''))) {
    return res.status(409).json({ message: 'El cobro o el expediente cambió mientras se guardaba. Revisa su estado actual y vuelve a intentarlo.', code: 'DISPUTE_STATE_CHANGED' })
  }
  return res.status(err.status || 500).json({ message: err.message || 'Internal server error', ...(err.status && err.code ? { code: err.code } : {}),...(err.checkoutRejected===true?{checkoutRejected:true}:{}) })
}

module.exports = { errorHandler }
