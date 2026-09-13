module.exports = Object.freeze({
  code: 'returns',
  dependencies: Object.freeze(['sales', 'inventory']),
  routePrefix: '/returns',
  loadRouter: () => require('./routes'),
})
