module.exports = Object.freeze({
  code: 'analytics',
  dependencies: Object.freeze(['sales']),
  routePrefix: '/analytics',
  loadRouter: () => require('../../routes/analytics.routes'),
})
