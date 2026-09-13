module.exports = Object.freeze({
  code: 'alerts',
  dependencies: Object.freeze(['inventory']),
  routePrefix: '/alerts',
  loadRouter: () => require('./routes'),
})
