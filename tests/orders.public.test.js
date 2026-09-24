const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveEffectiveModules } = require('../src/modules/platform/registry')

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function loadOrdersController(t, { prisma, getCompanyModuleBlock = async () => null }) {
  const controllerPath = require.resolve('../src/modules/orders/controller')
  const prismaPath = require.resolve('../src/models/prisma')
  const platformServicePath = require.resolve('../src/modules/platform/service')
  const cached = new Map([
    [controllerPath, require.cache[controllerPath]],
    [prismaPath, require.cache[prismaPath]],
    [platformServicePath, require.cache[platformServicePath]],
  ])

  require.cache[prismaPath] = { exports: { prisma, prismaTransaction: prisma } }
  require.cache[platformServicePath] = {
    exports: { getCompanyModuleBlock, readCompanyModules: async () => [] },
  }
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

test('getCompanyModuleBlock permite activo y bloquea desactivado, prueba vencida y dependencias', async () => {
  const { getCompanyModuleBlock } = require('../src/modules/platform/service')
  const scenarios = [
    {
      rows: [{ module_code: 'orders', status: 'ACTIVE' }],
      expected: null,
    },
    {
      rows: [{ module_code: 'orders', status: 'DISABLED' }],
      expected: { status: 'DISABLED', blockedBy: [] },
    },
    {
      rows: [{ module_code: 'orders', status: 'TRIAL', trial_ends_at: new Date('2020-01-01T00:00:00.000Z') }],
      expected: { status: 'TRIAL', blockedBy: [] },
    },
    {
      rows: [
        { module_code: 'orders', status: 'ACTIVE' },
        { module_code: 'inventory', status: 'DISABLED' },
        { module_code: 'contacts', status: 'ACTIVE' },
      ],
      expected: { status: 'ACTIVE', blockedBy: ['inventory'] },
    },
  ]

  for (const { rows, expected } of scenarios) {
    const block = await getCompanyModuleBlock(
      'company-a',
      'orders',
      async () => resolveEffectiveModules(rows),
    )
    if (!expected) assert.equal(block, null)
    else {
      assert.equal(block.code, 'MODULE_DISABLED')
      assert.equal(block.status, expected.status)
      assert.deepEqual(block.blockedBy, expected.blockedBy)
    }
  }
})

test('getShareLink limita el pedido al tenant y conserva un token existente', async (t) => {
  let orderQuery
  let tokenUpdated = false
  const tx = {
    commercialDocument: {
      findUnique: async () => ({ public_token: 'stable-token' }),
      update: async () => { tokenUpdated = true },
    },
  }
  const prisma = {
    commercialDocument: {
      findFirst: async (query) => {
        orderQuery = query
        return { id: 'order-a' }
      },
    },
    $transaction: async (callback) => callback(tx),
  }
  const Orders = loadOrdersController(t, { prisma })
  const res = responseStub()
  let error

  await Orders.getShareLink(
    { params: { id: 'PED-1' }, companyId: 'company-a' },
    res,
    (err) => { error = err },
  )

  assert.equal(error, undefined)
  assert.deepEqual(orderQuery.where.branch, { company_id: 'company-a' })
  assert.equal(tokenUpdated, false)
  assert.deepEqual(res.body, { public_token: 'stable-token', public_url: '/p/stable-token' })
})

test('getPublicByToken devuelve un pedido cancelado sin datos administrativos', async (t) => {
  let settingsQuery
  let moduleCompanyId
  const prisma = {
    commercialDocument: {
      findFirst: async () => ({
        id: 'internal-order-id',
        reference: 'PED-1',
        status: 'CANCELLED',
        created_at: new Date('2026-09-01T10:00:00.000Z'),
        updated_at: new Date('2026-09-02T10:00:00.000Z'),
        confirmed_at: null,
        valid_until: null,
        customer: 'Cliente Uno',
        customer_nit: '1234-5',
        is_final_consumer: false,
        sales_channel: 'WHOLESALE',
        subtotal: 100,
        discount_total: 0,
        total: 100,
        notes: 'Entregar por la tarde',
        branch_id: 'internal-branch-id',
        created_by: 'internal-user-id',
        branch: { company_id: 'company-a', name: 'Principal', code: 'PRIN' },
        customerContact: {
          id: 'internal-contact-id',
          name: 'Cliente Uno',
          contact: 'Ana',
          email: 'ana@example.com',
          phone: '5555-5555',
          address: 'Zona 1',
        },
        lines: [{
          id: 'internal-line-id',
          qty: 2,
          qty_fulfilled: 1,
          unit_price: 50,
          line_total: 100,
          product: { id: 'internal-product-id', name: 'Producto', barcode: 'SKU-1' },
        }],
        documentSales: [{
          id: 'internal-link-id',
          sale: { id: 'internal-sale-id', reference: 'FAC-1', total: 50, date: new Date('2026-09-02T00:00:00.000Z'), status: { name: 'Pagada' } },
        }],
        stock_reservations: [{ id: 'secret-reservation' }],
      }),
    },
    systemSetting: {
      findMany: async (query) => {
        settingsQuery = query
        return [
          { key: 'company_name', value: 'Auna Demo' },
          { key: 'company_logo_url', value: '/logo.png' },
        ]
      },
    },
  }
  const Orders = loadOrdersController(t, {
    prisma,
    getCompanyModuleBlock: async (companyId, code) => {
      moduleCompanyId = companyId
      assert.equal(code, 'orders')
      return null
    },
  })
  const res = responseStub()
  let error

  await Orders.getPublicByToken({ params: { token: 'public-token' } }, res, (err) => { error = err })

  assert.equal(error, undefined)
  assert.equal(moduleCompanyId, 'company-a')
  assert.deepEqual(settingsQuery.where, {
    key: { in: ['company_name', 'company_logo_url'] },
    company_id: 'company-a',
  })
  assert.equal(res.body.status, 'CANCELLED')
  assert.equal(res.body.company_name, 'Auna Demo')
  assert.equal(res.body.lines[0].product_name, 'Producto')
  assert.equal(res.body.sales[0].reference, 'FAC-1')
  assert.equal('id' in res.body, false)
  assert.equal('branch_id' in res.body, false)
  assert.equal('created_by' in res.body, false)
  assert.equal('stock_reservations' in res.body, false)
  assert.equal('id' in res.body.lines[0], false)
  assert.equal('id' in res.body.sales[0], false)
})

test('getPublicByToken no revela datos cuando el módulo está bloqueado', async (t) => {
  let settingsRead = false
  const block = {
    code: 'MODULE_DISABLED',
    message: 'El módulo Pedidos no está disponible para esta empresa',
    module: 'orders',
    status: 'DISABLED',
    blockedBy: [],
  }
  const prisma = {
    commercialDocument: {
      findFirst: async () => ({
        status: 'CONFIRMED',
        branch: { company_id: 'company-disabled' },
        lines: [],
        documentSales: [],
      }),
    },
    systemSetting: {
      findMany: async () => { settingsRead = true; return [] },
    },
  }
  const Orders = loadOrdersController(t, {
    prisma,
    getCompanyModuleBlock: async () => block,
  })
  const res = responseStub()

  await Orders.getPublicByToken({ params: { token: 'public-token' } }, res, assert.ifError)

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, block)
  assert.equal(settingsRead, false)
})

test('la ruta pública de pedidos evita tenant y la administrativa lo conserva', async (t) => {
  const express = require('express')
  const tenantPath = require.resolve('../src/middlewares/tenant')
  const platformPath = require.resolve('../src/modules/platform')
  const controllerPath = require.resolve('../src/modules/orders/controller')
  const routesPath = require.resolve('../src/routes')
  const cached = new Map([
    [tenantPath, require.cache[tenantPath]],
    [platformPath, require.cache[platformPath]],
    [controllerPath, require.cache[controllerPath]],
    [routesPath, require.cache[routesPath]],
  ])
  const jwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = 'orders-public-test-secret-32-characters'
  const handler = (req, res) => res.status(204).end()

  require.cache[tenantPath] = {
    exports: { ...require(tenantPath), resolveTenant: (req, res) => res.status(418).end() },
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
      'updateAdminDetails',
      'changeBranch',
      'confirm',
      'cancel',
      'convertToSale',
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

  assert.equal(await request('/orders/public/public-token'), 204)
  assert.equal(await request('/orders'), 418)
})
