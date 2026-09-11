const routes = Object.freeze([
  Object.freeze({
    routePrefix: '/products',
    loadRouter: () => require('../../routes/products.routes'),
  }),
  Object.freeze({
    routePrefix: '/stock',
    loadRouter: () => require('../../routes/stock.routes'),
  }),
  Object.freeze({
    routePrefix: '/warehouses',
    loadRouter: () => require('../../routes/warehouses.routes'),
  }),
])

module.exports = Object.freeze({
  code: 'inventory',
  dependencies: Object.freeze([]),
  routes,
})
