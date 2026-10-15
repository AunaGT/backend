const unavailableDatabaseCodes = new Set(['P1001', 'P1002', 'P1017', 'P2024'])

function errorHandler(err, req, res, next) {
  console.error(err)
  if (res.headersSent) return next(err)
  if (unavailableDatabaseCodes.has(err.code || err.errorCode)) {
    return res.status(503).json({ message: 'La conexión con la base de datos no está disponible temporalmente. Intenta de nuevo.' })
  }
  return res.status(err.status || 500).json({ message: err.message || 'Internal server error', ...(err.status && err.code ? { code: err.code } : {}) })
}

module.exports = { errorHandler }
