const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const path = require('path')
const swaggerUi = require('swagger-ui-express')
const swaggerJSDoc = require('swagger-jsdoc')
const { getReleaseInfo } = require('./src/config/release')
const { errorHandler } = require('./src/middlewares/errorHandler')

// Routers (placeholders, keep existing index for now)
const usuariosRoutes = require('./src/modules/users/routes')
// Las rutas de usuarios viven en su módulo y se exponen aquí para este arranque auxiliar.
const apiRoutes = require('./src/routes')

var app = express()

// Detrás del proxy de Vercel: necesario para que express-rate-limit lea la IP real (X-Forwarded-For).
app.set('trust proxy', 1)

// Cabeceras de seguridad. crossOriginResourcePolicy relajado porque servimos imágenes/PDFs a otro origen.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

// La API externa no participa en CORS, cookies ni parsers de la sesión ERP.
app.use('/api/integrations/v1', require('./src/modules/integrations/httpBoundary').createExternalBoundary(), require('./src/modules/integrations/routes').createExternalRouter())

// CORS: explicitly allow local dev frontends and production
const allowedOrigins = require('./src/config/httpOrigins')
const corsConfig = {
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) return callback(null, true) // allow tools/curl or same-origin
    if (allowedOrigins.has(origin)) return callback(null, true)
    return callback(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}

// CORS must be applied FIRST before any other middleware
app.use(cors(corsConfig))
app.use(require('./src/utils/requestTiming').requestTiming)

// Other middleware
app.use(cookieParser())
app.use('/api/settings/integrations', require('./src/modules/integrations/httpBoundary').createManagementBoundary())
app.use(express.static(path.join(__dirname, 'files')))
// Credential parsing has a private error boundary before broad import parsers.
// Authentication and resolved tenant permissions remain in the normal routes.
app.use('/api/settings/connectors', require('./src/modules/fiscal/bodyBoundary').createBodyBoundary())
app.use('/api/settings/customer-pages', require('./src/modules/config/customerPages/bodyBoundary').createBodyBoundary())
// Límite alto: importaciones mapeadas (JSON) y formularios grandes; alineado con multer en products.routes (10MB)
const bodyLimit = process.env.JSON_BODY_LIMIT || '10mb'
app.use(express.urlencoded({ extended: false, limit: bodyLimit }))
app.use(express.json({ limit: bodyLimit }))

// Swagger setup
const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Depósito API',
    version: '1.0.0',
    description: 'API para gestión de inventario, ventas y alertas',
  },
  servers: [{ url: '/api', description: 'API base' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
}
const swaggerOptions = {
  definition: swaggerDefinition,
  apis: [
    path.join(__dirname, 'src/routes/*.routes.js'),
    path.join(__dirname, 'src/controllers/*.js'),
    path.join(__dirname, 'src/modules/**/*.js'),
  ],
}
const swaggerSpec = swaggerJSDoc(swaggerOptions)
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

// routes
app.use('/api', apiRoutes)
app.use('/api/auth', usuariosRoutes)

// health
const { prisma } = require('./src/models/prisma.js')
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ ok: true, release: getReleaseInfo() })
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: 'DB connection failed',
      release: getReleaseInfo(),
    })
  }
})

// error handler
app.use(errorHandler)

module.exports = app
