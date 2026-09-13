module.exports = Object.freeze({
  code: 'dashboard',
  dependencies: Object.freeze([]),
  routePrefix: '/dashboard',
  loadRouter: () => require('../../routes/dashboard.routes'),
})
