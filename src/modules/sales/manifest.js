const routes = Object.freeze([
  Object.freeze({
    routePrefix: '/sales',
    loadRouter: () => require('../../routes/sales.routes'),
  }),
  Object.freeze({
    routePrefix: '/cash-sessions',
    loadRouter: () => require('../../routes/cashSessions.routes'),
  }),
])

module.exports = Object.freeze({
  code: 'sales',
  dependencies: Object.freeze(['inventory']),
  routes,
})
