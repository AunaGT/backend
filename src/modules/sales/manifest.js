const routes = Object.freeze([
  Object.freeze({
    routePrefix: '/sales',
    loadRouter: () => require('./sales.routes'),
  }),
  Object.freeze({
    routePrefix: '/cash-sessions',
    loadRouter: () => require('./cashSessions.routes'),
  }),
])

module.exports = Object.freeze({
  code: 'sales',
  dependencies: Object.freeze(['inventory']),
  routes,
})
