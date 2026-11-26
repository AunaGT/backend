const { Router } = require('express')
const { rateLimit } = require('express-rate-limit')
const service = require('./connectorService')
const selection = require('./providerSelection')
const { authorize } = require('./permissions')
const { fail } = require('./errors')
const { contractFor, assertExternalSendingAllowed } = require('./infile/contract')

function requestScope(req) {
  const { requireCompany, hasPerm } = require('../../middlewares/tenant')
  return { companyId: requireCompany(req), actorId: req.user?.sub, permissions: req.user?.permissions || [], isAdmin: hasPerm({ ...req.user, permissions: [] }, 'fiscal.view') }
}
function createRouter(options = {}) {
  const router = Router()
  const database = () => options.db || require('../../models/prisma').prisma
  const transactionDb = () => options.transactionDb || require('../../models/prisma').prismaTransaction
  const handler = run => async (req, res, next) => {
    try {
      const scope = authorize((options.scope || requestScope)(req))
      res.json(await run(req, scope))
    } catch (error) { next(error) }
  }
  const input = req => {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'environment')) throw fail(422, 'FISCAL_INPUT_INVALID', 'El entorno se selecciona desde la conexión')
    return { ...body, environment: req.params.environment }
  }
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
  router.use(options.auth || require('../../middlewares/autenticacion').Auth)
  router.use(require('./bodyBoundary').createBodyBoundary())
  router.use(rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Espera un momento antes de volver a revisar la conexión', code: 'FISCAL_RATE_LIMIT' } }))
  router.get('/', handler((_r, s) => selection.readProviderCatalog(database(), s)))
  router.put('/selection', handler((r, s) => selection.selectProvider(transactionDb(), s, r.body)))
  router.get('/infile/:environment', handler((r, s) => service.readInfileConnection(database(), s, r.params.environment, options)))
  router.put('/infile/:environment', handler((r, s) => service.saveInfileConnection(transactionDb(), s, input(r), options)))
  router.get('/infile/:environment/profile', handler((r, s) => service.readFiscalProfile(database(), s, r.params.environment)))
  router.put('/infile/:environment/profile', handler((r, s) => service.saveFiscalProfile(transactionDb(), s, input(r), options)))
  router.get('/infile/:environment/profile/options', handler((r, s) => { contractFor(r.params.environment); return service.profileOptions(database(), s, { kind: r.query.kind, query: r.query.query || '', page: r.query.page || '1' }) }))
  router.post('/infile/:environment/validate', handler((r, s) => service.validateConnectionLocally(transactionDb(), s, input(r), options)))
  router.get('/infile/:environment/history', handler((r, s) => service.connectionHistory(database(), s, r.params.environment)))
  for (const [path, permission] of [['tests', 'test'], ['activate', 'activate']]) {
    router.post(`/infile/:environment/${path}`, handler(async (r, s) => {
      authorize(s, permission); contractFor(r.params.environment); assertExternalSendingAllowed()
    }))
  }
  router.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ code: 'FISCAL_INPUT_TOO_LARGE', message: 'La solicitud supera el tamaño permitido' })
    if (error.type === 'entity.parse.failed') return res.status(400).json({ code: 'FISCAL_INPUT_INVALID', message: 'La solicitud no contiene un JSON válido' })
    if (error.code?.startsWith('FISCAL_') && error.status >= 400 && error.status <= 599) return res.status(error.status).json({ code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) })
    const missing = ['P2021', 'P2022'].includes(error.code)
    res.status(missing ? 503 : 500).json({ code: missing ? 'FISCAL_STORAGE_NOT_READY' : 'FISCAL_OPERATION_FAILED', message: missing ? 'Falta preparar el almacenamiento fiscal del servidor. Solicita a tu administrador aplicar la actualización.' : 'No se pudo completar la operación del conector. Inténtalo de nuevo.' })
  })
  return router
}
module.exports = { createRouter, requestScope }
