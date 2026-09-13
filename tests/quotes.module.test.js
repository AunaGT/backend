const test = require('node:test')
const assert = require('node:assert/strict')

// Algunos controladores cargan el middleware de autenticación al importarse.
// La prueba no firma tokens reales, pero debe proporcionar una clave aislada
// para no depender del .env local del desarrollador o del CI.
process.env.JWT_SECRET ||= 'auna-module-tests-only-not-for-production-2026'

const { resolveEffectiveModules } = require('../src/modules/platform/registry')

function responseStub() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.payload = payload; return this },
  }
}

function loadQuotesController(t, mocks) {
  const controllerPath = require.resolve('../src/controllers/quotes.controller')
  require(controllerPath)
  const replacements = new Map(Object.entries(mocks).map(([path, exports]) => [require.resolve(path), exports]))
  const cached = new Map([...replacements.keys(), controllerPath].map((path) => [path, require.cache[path]]))

  for (const [path, exports] of replacements) require.cache[path] = { exports }
  delete require.cache[controllerPath]
  const controller = require(controllerPath)

  t.after(() => {
    for (const [path, value] of cached) {
      if (value) require.cache[path] = value
      else delete require.cache[path]
    }
  })

  return controller
}

function quoteControllerMocks(prisma, prismaTransaction) {
  return {
    '../src/models/prisma': { prisma, prismaTransaction },
    '../src/services/priceResolution': {
      resolvePriceTierForContext: async () => 'WHOLESALE',
      resolveUnitPriceFromProduct: () => 10,
      productSupportsPriceTier: () => ({ ok: true }),
      parsePriceTier: () => null,
      VALID_CHANNELS: new Set(['WHOLESALE']),
    },
    '../src/services/referenceGenerator': {
      nextDocumentReference: async () => 'COT-1',
    },
    '../src/middlewares/tenant': {
      targetBranch: (req) => req.branchId,
      branchWhere: () => ({}),
    },
    '../src/services/stockAvailability': {
      assertLinesAvailable: async () => {},
      reserveForDocument: async () => {},
      releaseByDocument: async () => {},
    },
  }
}

test('la conversión continúa cuando Pedidos está activo', () => {
  const { requireOrdersForConversion } = require('../src/modules/quotes/access')
  const req = {
    companyModules: resolveEffectiveModules([
      { module_code: 'orders', status: 'ACTIVE' },
    ]),
  }
  let continued = false

  requireOrdersForConversion(req, responseStub(), () => { continued = true })

  assert.equal(continued, true)
})

test('la conversión responde MODULE_DISABLED cuando Pedidos está desactivado', () => {
  const { requireOrdersForConversion } = require('../src/modules/quotes/access')
  const req = {
    companyModules: resolveEffectiveModules([
      { module_code: 'orders', status: 'DISABLED' },
    ]),
  }
  const res = responseStub()
  let continued = false

  requireOrdersForConversion(req, res, () => { continued = true })

  assert.equal(continued, false)
  assert.equal(res.statusCode, 403)
  assert.equal(res.payload.code, 'MODULE_DISABLED')
  assert.equal(res.payload.module, 'orders')
})

test('el acceso público continúa cuando Cotizaciones está activo', async () => {
  const { getCompanyModuleBlock } = require('../src/modules/quotes/access')
  const loadModules = async (companyId) => {
    assert.equal(companyId, 'company-active')
    return resolveEffectiveModules([{ module_code: 'quotes', status: 'ACTIVE' }])
  }

  const block = await getCompanyModuleBlock('company-active', 'quotes', loadModules)

  assert.equal(block, null)
})

test('el acceso público se bloquea cuando una dependencia de Cotizaciones está inactiva', async () => {
  const { getCompanyModuleBlock } = require('../src/modules/quotes/access')
  const loadModules = async () => resolveEffectiveModules([
    { module_code: 'quotes', status: 'ACTIVE' },
    { module_code: 'contacts', status: 'DISABLED' },
  ])

  const block = await getCompanyModuleBlock('company-blocked', 'quotes', loadModules)

  assert.equal(block.code, 'MODULE_DISABLED')
  assert.equal(block.module, 'quotes')
  assert.deepEqual(block.blockedBy, ['contacts'])
})

test('el branding público se consulta para la empresa resuelta por el token', async (t) => {
  let settingsQuery
  const prisma = {
    commercialDocument: {
      findFirst: async () => ({
        reference: 'COT-1',
        status: 'DRAFT',
        customer: null,
        customer_nit: null,
        is_final_consumer: true,
        valid_until: null,
        subtotal: 0,
        total: 0,
        notes: null,
        branch: { company_id: 'company-a' },
        lines: [],
      }),
    },
    systemSetting: {
      findMany: async (query) => {
        settingsQuery = query
        return []
      },
    },
  }
  const Quotes = loadQuotesController(t, {
    '../src/models/prisma': { prisma, prismaTransaction: {} },
    '../src/modules/quotes/access': {
      getCompanyModuleBlock: async (companyId) => {
        assert.equal(companyId, 'company-a')
        return null
      },
    },
  })
  const res = responseStub()
  let error

  await Quotes.getPublicByToken({ params: { token: 'public-token' } }, res, (err) => { error = err })

  assert.equal(error, undefined)
  assert.deepEqual(settingsQuery.where, {
    key: { in: ['company_name', 'company_logo_url'] },
    company_id: 'company-a',
  })
})

test('la configuración comercial se consulta dentro de la empresa indicada', async () => {
  let settingsQuery
  const db = {
    systemSetting: {
      findMany: async (query) => {
        settingsQuery = query
        return []
      },
    },
  }
  const { getCommercialDocSettings } = require('../src/services/commercialDocumentSettings')

  await getCommercialDocSettings(db, 'company-a')

  assert.deepEqual(settingsQuery.where, {
    key: { in: ['quote_validity_days', 'order_validity_days', 'quote_soft_hold_hours'] },
    company_id: 'company-a',
  })
})

test('crear una cotización consulta la vigencia de la empresa del request', async (t) => {
  let settingsQuery
  const tx = {
    product: {
      findMany: async () => [{ id: 'product-a', name: 'Producto', available_for_sale: true }],
    },
    systemSetting: {
      findMany: async (query) => {
        settingsQuery = query
        return []
      },
    },
    branch: {
      findUnique: async () => ({ id: 'branch-a', code: 'A', seq: 1 }),
    },
    commercialDocument: {
      create: async () => ({ id: 'quote-a' }),
    },
  }
  const prismaTransaction = { $transaction: async (callback) => callback(tx) }
  const Quotes = loadQuotesController(t, quoteControllerMocks({}, prismaTransaction))
  const res = responseStub()
  let error

  await Quotes.create({
    user: { sub: 'user-a' },
    companyId: 'company-a',
    branchId: 'branch-a',
    body: { items: [{ product_id: 'product-a', qty: 1 }] },
  }, res, (err) => { error = err })

  assert.equal(error, undefined)
  assert.equal(settingsQuery.where.company_id, 'company-a')
})

test('reiniciar la vigencia al editar usa la empresa del request', async (t) => {
  let settingsQuery
  const existing = {
    id: 'quote-a',
    status: 'DRAFT',
    valid_until: new Date('2026-10-01T00:00:00.000Z'),
    customer_contact_id: null,
    sales_channel: 'WHOLESALE',
    branch_id: 'branch-a',
  }
  const prisma = {
    commercialDocument: { findFirst: async () => existing },
  }
  const tx = {
    product: {
      findMany: async () => [{ id: 'product-a', name: 'Producto', available_for_sale: true }],
    },
    systemSetting: {
      findMany: async (query) => {
        settingsQuery = query
        return []
      },
    },
    commercialDocumentLine: { deleteMany: async () => {} },
    commercialDocument: { update: async () => ({ id: 'quote-a' }) },
  }
  const prismaTransaction = { $transaction: async (callback) => callback(tx) }
  const Quotes = loadQuotesController(t, quoteControllerMocks(prisma, prismaTransaction))
  const res = responseStub()
  let error

  await Quotes.update({
    user: { sub: 'user-a' },
    companyId: 'company-a',
    params: { id: 'quote-a' },
    body: { items: [{ product_id: 'product-a', qty: 1 }], valid_until: '' },
  }, res, (err) => { error = err })

  assert.equal(error, undefined)
  assert.equal(settingsQuery.where.company_id, 'company-a')
})

test('enviar una cotización consulta el soft-hold de la empresa del request', async (t) => {
  let settingsQuery
  const prisma = {
    commercialDocument: {
      findFirst: async () => ({
        id: 'quote-a',
        status: 'DRAFT',
        branch_id: 'branch-a',
        _count: { lines: 1 },
      }),
    },
  }
  const tx = {
    commercialDocumentLine: {
      findMany: async () => [{ product_id: 'product-a', qty: 1 }],
    },
    commercialDocument: {
      findUnique: async () => ({ public_token: 'public-token' }),
      update: async () => ({ id: 'quote-a', status: 'SENT' }),
    },
    systemSetting: {
      findMany: async (query) => {
        settingsQuery = query
        return []
      },
    },
  }
  const prismaTransaction = { $transaction: async (callback) => callback(tx) }
  const Quotes = loadQuotesController(t, quoteControllerMocks(prisma, prismaTransaction))
  const res = responseStub()
  let error

  await Quotes.updateStatus({
    user: { sub: 'user-a' },
    companyId: 'company-a',
    params: { id: 'quote-a' },
    body: { status: 'SENT' },
  }, res, (err) => { error = err })

  assert.equal(error, undefined)
  assert.equal(settingsQuery.where.company_id, 'company-a')
})

test('el vencimiento selecciona cotizaciones de empresas con módulo activo', async () => {
  const { filterEnabledQuoteIds } = require('../src/services/commercialDocumentExpiry')
  const rows = [
    { id: 'quote-active', branch: { company_id: 'company-active' } },
    { id: 'quote-disabled', branch: { company_id: 'company-disabled' } },
  ]
  const loadModules = async (companyId) => resolveEffectiveModules([
    {
      module_code: 'quotes',
      status: companyId === 'company-active' ? 'ACTIVE' : 'DISABLED',
    },
  ])

  const ids = await filterEnabledQuoteIds(rows, {}, loadModules)

  assert.deepEqual(ids, ['quote-active'])
})

test('el vencimiento omite cotizaciones bloqueadas por dependencias', async () => {
  const { filterEnabledQuoteIds } = require('../src/services/commercialDocumentExpiry')
  const rows = [{ id: 'quote-no-inventory', branch: { company_id: 'company-1' } }]
  const loadModules = async () => resolveEffectiveModules([
    { module_code: 'quotes', status: 'ACTIVE' },
    { module_code: 'inventory', status: 'DISABLED' },
  ])

  const ids = await filterEnabledQuoteIds(rows, {}, loadModules)

  assert.deepEqual(ids, [])
})

test('el vencimiento procesa únicamente pedidos de empresas con el módulo activo', async () => {
  const { filterEnabledOrderIds } = require('../src/services/commercialDocumentExpiry')
  const rows = [
    { id: 'order-active', branch: { company_id: 'company-active' } },
    { id: 'order-disabled', branch: { company_id: 'company-disabled' } },
  ]
  const loadModules = async (companyId) => resolveEffectiveModules([
    {
      module_code: 'orders',
      status: companyId === 'company-active' ? 'ACTIVE' : 'DISABLED',
    },
  ])

  const ids = await filterEnabledOrderIds(rows, {}, loadModules)

  assert.deepEqual(ids, ['order-active'])
})

test('la cotización pública evita tenant y las rutas privadas lo conservan', async (t) => {
  const express = require('express')
  const tenantPath = require.resolve('../src/middlewares/tenant')
  const platformPath = require.resolve('../src/modules/platform')
  const controllerPath = require.resolve('../src/controllers/quotes.controller')
  const routesPath = require.resolve('../src/routes')
  const cached = new Map([
    [tenantPath, require.cache[tenantPath]],
    [platformPath, require.cache[platformPath]],
    [controllerPath, require.cache[controllerPath]],
    [routesPath, require.cache[routesPath]],
  ])
  const jwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters'
  const handler = (req, res) => res.status(204).end()

  require.cache[tenantPath] = {
    exports: {
      ...require(tenantPath),
      resolveTenant: (req, res) => res.status(418).end(),
    },
  }
  require.cache[platformPath] = {
    exports: {
      requireModule: () => (req, res, next) => next(),
      requireAnyModule: () => (req, res, next) => next(),
    },
  }
  require.cache[controllerPath] = {
    exports: Object.fromEntries([
      'getPublicByToken',
      'list',
      'create',
      'getShareLink',
      'getById',
      'update',
      'updateStatus',
      'convertToOrder',
    ].map((name) => [name, handler])),
  }
  delete require.cache[routesPath]

  const app = express().use(require('../src/routes'))
  t.after(() => {
    for (const [path, value] of cached) {
      if (value) require.cache[path] = value
      else delete require.cache[path]
    }
    if (jwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = jwtSecret
  })

  const request = (url) => new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: {} }
    const headers = {}
    const res = {
      statusCode: 200,
      setHeader(name, value) { headers[name.toLowerCase()] = value },
      getHeader(name) { return headers[name.toLowerCase()] },
      removeHeader(name) { delete headers[name.toLowerCase()] },
      end() { resolve(this.statusCode) },
    }
    app.handle(req, res, reject)
  })

  assert.equal(await request('/quotes/public/token-value'), 204)
  assert.equal(await request('/quotes'), 418)
})
