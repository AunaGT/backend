module.exports = Object.freeze({
  code: 'inventory-count',
  dependencies: Object.freeze(['inventory']),
  routePrefix: '/inventory-counts',
  loadRouter: () => require('./routes'),
})
