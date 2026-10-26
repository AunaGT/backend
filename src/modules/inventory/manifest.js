const routes = Object.freeze([
  Object.freeze({
    routePrefix: '/commercial-packages',
    loadRouter: () => require('./packages/routes'),
  }),
  Object.freeze({
    routePrefix: '/products',
    loadRouter: () => require('./products.routes'),
  }),
  Object.freeze({
    routePrefix: '/stock',
    loadRouter: () => require('./stock.routes'),
  }),
  Object.freeze({
    routePrefix: '/warehouses',
    loadRouter: () => require('./warehouses.routes'),
  }),
])

module.exports = Object.freeze({
  code: 'inventory',
  dependencies: Object.freeze([]),
  routes,
})
