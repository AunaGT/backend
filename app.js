const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const path = require('path')
const swaggerUi = require('swagger-ui-express')
const swaggerJSDoc = require('swagger-jsdoc')

// Routers (placeholders, keep existing index for now)
const usuariosRoutes = require('./src/routes/usuarios.routes')
// If you later add files like ./src/routes/usuarios.routes.js in CJS, import here and spread in /api
const apiRoutes = require('./src/routes')

var app = express()

// Detrás del proxy de Vercel: necesario para que express-rate-limit lea la IP real (X-Forwarded-For).
app.set('trust proxy', 1)

// Cabeceras de seguridad. crossOriginResourcePolicy relajado porque servimos imágenes/PDFs a otro origen.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

// CORS: explicitly allow local dev frontends and production
const allowedOrigins = new Set([
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://deposito-frontend.vercel.app',
  'https://auna-frontend.vercel.app',
  'http://localhost:3000',
])
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

// Other middleware
app.use(cookieParser())
app.use(express.static(path.join(__dirname, 'files')))
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
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: 'DB connection failed' })
  }
})

// error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' })
})

module.exports = app
