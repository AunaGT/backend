require('./src/config/loadEnv')
const app = require('./app')

// For Vercel serverless, export the app
module.exports = app

// For local development, start the server
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 3000
  app.listen(port, () => {
    console.log(`Server running on port ${port}`)
    try {
      const { startCommercialDocumentScheduler } = require('./src/jobs/commercialDocumentScheduler')
      startCommercialDocumentScheduler()
    } catch (e) {
      console.warn('[commercial-doc-expiry] scheduler no iniciado:', e.message)
    }
  })
}
