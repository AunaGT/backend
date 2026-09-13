module.exports = Object.freeze({
  code: 'reports',
  dependencies: Object.freeze(['sales', 'inventory']),
  routePrefix: '/reports',
  loadRouter: () => require('../../routes/reports.routes'),
})
