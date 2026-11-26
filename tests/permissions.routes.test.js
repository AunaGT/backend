const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jwt-simple')
const { secret } = require('../src/config/security')
const { Auth } = require('../src/middlewares/autenticacion')
const { resolveEffectiveModules } = require('../src/modules/platform/registry')
const { withMocks, jsonResponse } = require('./helpers/reportHarness.cjs')

// Exercise the actual authentication, dependency expansion and route guards.
// Only the final business handler and persistence are replaced.
async function routeAccess(module, controller, method, path, permissions, body = {}, query = {}) {
  const target = require.resolve(`../src/modules/${module}`)
  const terminal = new Proxy({}, { get: (_, handler) => (req, res) => res.json({ handler }) })
  const modules = resolveEffectiveModules([]).map(m=>module==='reports/routes'?{...m,effectiveEnabled:true}:m)
  const role = { id: 42, name: 'Operador', company_id: 'A', permissions: permissions.map(code => ({ permission: { code } })) }
  const req = {
    method: method.toUpperCase(), path, params: { id: 'P' }, query, body,
    companyId: 'A', branchId: 'B', companyModules: modules,
    headers: { authorization: `Bearer ${jwt.encode({ sub: 'U', exp: Math.floor(Date.now() / 1000) + 60 }, secret)}` },
    sessionUser: { id: 'U', role, user_companies: [{ company_id: 'A', status: 'ACTIVE', role }] },
  }
  const res = { ...jsonResponse(), send(value) { return this.json(value) } }
  await withMocks({
    [require.resolve('../src/models/prisma')]: { prisma: { companyModule: { findMany: async () => [] } } },
    [require.resolve(`../src/modules/${controller}`)]: terminal,
    ...(module==='reports/routes'?{[require.resolve('../src/modules/reports/stock.controller')]:terminal}:{}),
  }, target, async router => {
    const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route
    assert.ok(route, `${method} ${module} ${path}`)
    const handlers = [Auth, ...route.stack.map(layer => layer.handle)]
    for (const handler of handlers) {
      let continued = false
      await handler(req, res, error => { if (error) throw error; continued = true })
      if (!continued) break
    }
  })
  return res
}

test('cash configuration routes separate metadata and access management from cash operations', async () => {
  for (const [method, path, permission] of [['get', '/registers/:id/configuration', 'cash.registers.view'], ['put', '/registers/:id/configuration', 'cash.registers.manage'], ['post', '/registers/configuration', 'cash.registers.manage'], ['get', '/register-users', 'cash.registers.manage']]) {
    for (const denied of ['settings.manage', 'sales.create', 'cashclosure.create']) assert.equal((await routeAccess('sales/cashSessions.routes', 'sales/cashSessions.controller', method, path, [denied])).statusCode, 403)
    assert.ok((await routeAccess('sales/cashSessions.routes', 'sales/cashSessions.controller', method, path, [permission])).body.handler)
  }
  for (const path of ['/open','/close']) assert.equal((await routeAccess('sales/cashSessions.routes', 'sales/cashSessions.controller', 'post', path, ['cash.registers.manage'])).statusCode, 403)
})

test('catalog reads require products.view, including BOM and detail; sales operators retain access', async () => {
  for (const path of ['/', '/:id', '/:id/bom']) {
    assert.equal((await routeAccess('inventory/products.routes', 'inventory/products.controller', 'get', path, [])).statusCode, 403)
    for (const permission of ['products.view', 'sales.create', 'quotes.create', 'orders.create']) {
      assert.ok((await routeAccess('inventory/products.routes', 'inventory/products.controller', 'get', path, [permission])).body.handler)
    }
  }
})

test('administrative promotions are private; cart validation remains available to sellers', async () => {
  for (const path of ['/', '/:id', '/code/:code', '/types']) {
    assert.equal((await routeAccess('promotions/routes', 'promotions/controller', 'get', path, [])).statusCode, 403)
    assert.ok((await routeAccess('promotions/routes', 'promotions/controller', 'get', path, ['promotions.view'])).body.handler)
  }
  for (const path of ['/validate', '/calculate']) {
    assert.equal((await routeAccess('promotions/routes', 'promotions/controller', 'post', path, [])).statusCode, 403)
    assert.ok((await routeAccess('promotions/routes', 'promotions/controller', 'post', path, ['sales.create'])).body.handler)
  }
})

test('converting an order requires both managing orders and creating sales', async () => {
  for (const permission of ['orders.manage', 'sales.create']) {
    assert.equal((await routeAccess('orders/routes', 'orders/controller', 'post', '/:id/convert-to-sale', [permission])).statusCode, 403)
  }
  assert.ok((await routeAccess('orders/routes', 'orders/controller', 'post', '/:id/convert-to-sale', ['orders.manage', 'sales.create'])).body.handler)
})

test('converting a quote requires managing quotes and creating the destination order', async () => {
  for (const permissions of [['quotes.manage'], ['orders.create'], []]) {
    assert.equal((await routeAccess('quotes/routes', 'quotes/controller', 'post', '/:id/convert-to-order', permissions)).statusCode, 403)
  }
  assert.ok((await routeAccess('quotes/routes', 'quotes/controller', 'post', '/:id/convert-to-order', ['quotes.manage', 'orders.create'])).body.handler)
})

test('sales.create is not cancellation authority', async () => {
  assert.equal((await routeAccess('sales/sales.routes', 'sales/controller', 'patch', '/:id/status', ['sales.create'])).statusCode, 403)
  assert.ok((await routeAccess('sales/sales.routes', 'sales/controller', 'patch', '/:id/status', ['sales.cancel'])).body.handler)
})

test('sales.view is list-only, not arbitrary detailed sale access', async () => {
  assert.equal((await routeAccess('sales/sales.routes', 'sales/controller', 'get', '/:id', ['sales.view'])).statusCode, 403)
  for (const permission of ['sales.view_detail', 'sales.view_invoice', 'returns.manage']) {
    assert.ok((await routeAccess('sales/sales.routes', 'sales/controller', 'get', '/:id', [permission])).body.handler)
  }
})

test('independent unit and presentation mutations require editing existing products', async () => {
  for (const [method, path] of [['put', '/:id/units'], ['post', '/:id/presentations'], ['put', '/:id/presentations/:presentationId'], ['delete', '/:id/presentations/:presentationId']]) {
    assert.equal((await routeAccess('inventory/units/routes', 'inventory/units/controller', method, path, ['products.create'])).statusCode, 403)
    assert.ok((await routeAccess('inventory/units/routes', 'inventory/units/controller', method, path, ['products.edit'])).body.handler)
  }
})

test('recording money does not authorize cancelling or correcting it', async () => {
  for (const [module, controller, method, path, oldPermission, permission] of [
    ['receivables/routes', 'receivables/controller', 'delete', '/payments/:id', 'receivables.manage', 'receivables.cancel_payment'],
    ['merchandise/routes', 'merchandise/controller', 'delete', '/:id/payments/:entryId', 'merchandise.mark_paid', 'merchandise.cancel_payment'],
    ['merchandise/payables/routes', 'merchandise/payables/controller', 'post', '/payments/:id/cancel', 'merchandise.mark_paid', 'merchandise.cancel_payment'],
    ['merchandise/payables/routes', 'merchandise/payables/controller', 'post', '/entries/:id/correct', 'merchandise.mark_paid', 'merchandise.correct_payment'],
    ['returns/routes', 'returns/controller', 'post', '/:id/approve', 'returns.manage', 'returns.approve'],
    ['returns/routes', 'returns/controller', 'post', '/:id/complete', 'returns.manage', 'returns.complete'],
  ]) {
    assert.equal((await routeAccess(module, controller, method, path, [oldPermission])).statusCode, 403, path)
    assert.ok((await routeAccess(module, controller, method, path, [permission])).body.handler, path)
  }
})
test('legacy return status route checks the requested action, not the old manage permission',async()=>{
 for(const [status_name,permission]of [['Aprobada','returns.approve'],['Rechazada','returns.approve'],['Completada','returns.complete']]){
  for(const denied of ['returns.manage',permission==='returns.approve'?'returns.complete':'returns.approve'])assert.equal((await routeAccess('returns/routes','returns/controller','patch','/:id/status',[denied],{status_name})).statusCode,403)
  assert.ok((await routeAccess('returns/routes','returns/controller','patch','/:id/status',[permission],{status_name})).body.handler)
 }
})
test('return settlement can look up its current cash session without permission to open or close one',async()=>{
 assert.ok((await routeAccess('sales/cashSessions.routes','sales/cashSessions.controller','get','/current',['returns.complete'])).body.handler)
 for(const path of ['/open','/close'])assert.equal((await routeAccess('sales/cashSessions.routes','sales/cashSessions.controller','post',path,['returns.complete'])).statusCode,403)
})
test('valued reports require financial authority plus their base access in every output format',async()=>{
 for(const [path,permission]of [['/financial','reports.view'],['/inventory','reports.view'],['/suppliers','reports.view'],['/products','reports.view'],['/alerts','reports.view'],['/merchandise','merchandise.reports'],['/inventory-counts','inventory_count.view'],['/inventory-count-session/:id','inventory_count.view'],['/stock-by-location','stock_moves.view']]){
  for(const format of ['json','pdf','csv','excel']){
   assert.equal((await routeAccess('reports/routes','reports/controller','get',path,[permission],{}, {format})).statusCode,403,path+format)
   assert.ok((await routeAccess('reports/routes','reports/controller','get',path,[permission,'reports.financial'],{}, {format})).body.handler,path+format)
   assert.equal((await routeAccess('reports/routes','reports/controller','get',path,['reports.financial'],{}, {format})).statusCode,403,path+format)
  }
 }
 for(const path of ['/sales','/kardex','/internal-moves','/replenishment','/occupancy'])assert.ok((await routeAccess('reports/routes','reports/controller','get',path,['reports.view'])).body.handler,path)
 assert.equal((await routeAccess('inventory/products.routes','inventory/products.controller','get','/report.pdf',['products.export'])).statusCode,403)
 assert.ok((await routeAccess('inventory/products.routes','inventory/products.controller','get','/report.pdf',['products.export','products.view_costs'])).body.handler)
})
test('analytic summary requires financial authorization, not just analytics access',async()=>{
 assert.equal((await routeAccess('analytics/routes','analytics/controller','get','/summary',['analytics.view'])).statusCode,403)
 assert.ok((await routeAccess('analytics/routes','analytics/controller','get','/summary',['analytics.view','reports.financial'])).body.handler)
})
